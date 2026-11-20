'use strict';

// Headless smoke test for runtime/loader.js using a fake Electron main process.
// It does not launch Qobuz and does not touch the real Qobuz user data.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qobuz-mods-smoke-'));
const userData = path.join(temp, 'Qobuz');
fs.mkdirSync(userData, { recursive: true });

const configDir = path.join(temp, 'QobuzMods');
const logFile = path.join(temp, 'qobuz-mods.log');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify(
    {
      version: 1,
      enabled: { 'now-playing': false },
      options: {},
    },
    null,
    2,
  ),
);

process.env.QOBUZ_MODS_CONFIG_DIR = configDir;
process.env.QOBUZ_MODS_LOG = logFile;

class FakeIpcMain extends EventEmitter {
  constructor() {
    super();
    this.handlers = new Map();
  }

  handle(channel, fn) {
    if (this.handlers.has(channel)) throw new Error(`duplicate handler ${channel}`);
    this.handlers.set(channel, fn);
  }

  async invoke(channel, ...args) {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return fn({}, ...args);
  }
}

class FakeApp extends EventEmitter {
  constructor() {
    super();
    this.ready = false;
    this.paths = {
      userData,
      logs: path.join(temp, 'logs'),
      temp,
    };
  }

  getPath(name) {
    return this.paths[name] || temp;
  }

  getVersion() {
    return '8.3.0-b028';
  }

  getName() {
    return 'Qobuz';
  }

  getLocale() {
    return 'en-US';
  }

  isReady() {
    return this.ready;
  }

  whenReady() {
    this.ready = true;
    return Promise.resolve();
  }

  relaunch() {}

  exit() {}
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.url = 'file:///tmp/app.html';
    this.sent = [];
    this.injected = [];
    this.destroyed = false;
  }

  send(channel, ...args) {
    this.sent.push([channel, ...args]);
  }

  getURL() {
    return this.url;
  }

  isLoading() {
    return false;
  }

  isDestroyed() {
    return this.destroyed;
  }

  executeJavaScript(code) {
    this.injected.push(code);
    return Promise.resolve(true);
  }
}

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.webContents = new FakeWebContents();
    this.destroyed = false;
  }

  isDestroyed() {
    return this.destroyed;
  }
}

const fakeApp = new FakeApp();
const fakeIpcMain = new FakeIpcMain();
const fakeShortcut = {
  register() {
    return true;
  },
  unregister() {
    return true;
  },
};

const fakePreloads = [];
const fakeElectron = {
  app: fakeApp,
  ipcMain: fakeIpcMain,
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
  },
  session: {
    defaultSession: {
      getPreloads: () => [...fakePreloads],
      setPreloads: (next) => {
        fakePreloads.length = 0;
        fakePreloads.push(...next);
      },
    },
  },
  globalShortcut: fakeShortcut,
  shell: {
    async openPath() {
      return '';
    },
    async openExternal() {},
    showItemInFolder() {},
  },
  dialog: {},
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function waitFor(predicate, message, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out: ${message}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function main() {
  const loaderPath = path.resolve(__dirname, process.env.QOBUZ_MODS_TEST_LOADER || '../runtime/loader');
  const loader = require(loaderPath);
  assert(loader && typeof loader.list === 'function', 'loader exports list()');
  assert(global.__qobuzMods === loader, 'global.__qobuzMods is the loader API');

  assert(
    fakePreloads.some((p) => p.endsWith('/runtime/renderer.js')),
    'renderer preload installed on the default session',
  );

  const sources = await fakeIpcMain.invoke('qobuzmods:renderer-sources');
  assert(Array.isArray(sources), 'renderer-sources returns an array');
  assert(
    sources.some((source) => source.id === 'mods-menu'),
    'renderer sources include the mods menu',
  );

  const win = new FakeWindow();
  fakeApp.emit('browser-window-created', {}, win);

  const trackEvents = [];
  const artworkEvents = [];
  loader.player.on('track', (event) => trackEvents.push(event));
  loader.player.on('artwork', (event) => artworkEvents.push(event));

  // Shape produced by the renderer's mapTrack() before it is sent to
  // player-load-music: performer.name, album.title, album.image.
  const track = {
    id: 12345,
    title: 'Wave',
    duration: 229,
    performer: { id: 1, name: 'Remi Wolf' },
    album: {
      id: 'xne8h1xxlpfbc',
      title: 'Big Ideas',
      image: { small: 'https://static.qobuz.com/example.jpg' },
    },
  };
  const fileData = { track_id: 12345, format_id: 27, url_template: 'https://example' };

  fakeIpcMain.emit('player-load-music', {}, 'load-1', track, fileData, 0);
  fakeIpcMain.emit('player-play-music', {});

  const expectedCover = path.join(userData, 'tmp', 'Assets', track.album.id, 'small_cover.png');
  const afterLoad = await fakeIpcMain.invoke('qobuzmods:doctor');
  assert(afterLoad.player.hasTrack, 'doctor sees loaded track');
  assert(
    afterLoad.player.track.artworkExpectedPath === expectedCover,
    'loader knows where Qobuz will download the cover',
  );
  assert(afterLoad.player.track.artworkPath === '', 'cover is not reported before it exists');

  // Qobuz downloads album covers asynchronously after the track is loaded.
  fs.mkdirSync(path.dirname(expectedCover), { recursive: true });
  fs.writeFileSync(expectedCover, Buffer.from('fake png'));
  await waitFor(() => {
    const doctorNow = loader.doctor();
    return doctorNow.player.track && doctorNow.player.track.artworkPath === expectedCover;
  }, 'artwork event/state updated after cover appears');
  assert(
    artworkEvents.some((event) => event.artworkPath === expectedCover),
    'an artwork event is emitted when the cover appears',
  );

  // This is how Qobuz publishes progress: main -> renderer via webContents.send.
  win.webContents.send('player-refresh-music-info', {
    timestamp: Date.now(),
    position: 12.5,
    status: 'Playing',
    endOfFile: false,
  });

  // Gapless playback: Qobuz prepares the next track, then switches to it
  // without sending player-load-music.
  const nextTrack = {
    id: 67890,
    title: 'Photo ID',
    duration: 254,
    performer: { id: 2, name: 'Remi Wolf' },
    album: {
      id: 'album-two',
      title: 'Big Ideas',
      image: { small: 'https://static.qobuz.com/example-2.jpg' },
    },
  };
  fakeIpcMain.emit(
    'player-prepare-next-track',
    {},
    'prepare-1',
    nextTrack,
    { track_id: 67890, format_id: 27 },
  );
  fakeIpcMain.emit('player-switch-channel', {}, 'switch-1', 1);

  const afterSwitch = await fakeIpcMain.invoke('qobuzmods:doctor');
  assert(afterSwitch.player.track && afterSwitch.player.track.id === '67890', 'gapless switch updates track');
  assert(afterSwitch.player.track.title === 'Photo ID', 'gapless switch updates title');
  assert(afterSwitch.player.playing === true, 'gapless switch marks playback as playing');
  assert(
    trackEvents.some((event) => event.source === 'player-switch-channel' && event.track.id === '67890'),
    'gapless switch emits a track event',
  );

  const toggled = await fakeIpcMain.invoke('qobuzmods:set-enabled', 'now-playing', true);
  assert(toggled.restartRequired === true, 'toggling sets restartRequired');
  assert(
    toggled.mods.find((mod) => mod.id === 'now-playing').enabled === true,
    'now-playing enabled in config',
  );

  const doctor = await fakeIpcMain.invoke('qobuzmods:doctor');
  assert(doctor.player.hasTrack, 'doctor sees current track');
  assert(doctor.player.playing, 'doctor sees playing state');
  assert(doctor.player.track.id === '67890', 'doctor sees the gapless-switched track');
  assert(doctor.mods.length >= 2, 'doctor lists mods');

  const mods = await fakeIpcMain.invoke('qobuzmods:list');
  assert(mods.mods.some((m) => m.id === 'mods-menu' && m.core), 'core menu listed');
  assert(mods.mods.some((m) => m.id === 'now-playing'), 'now-playing listed');
  assert(!mods.mods.some((m) => m.id === 'last-played'), 'last-played is gone');

  fakeApp.emit('before-quit');

  const log = fs.readFileSync(logFile, 'utf8');
  assert(log.includes('loader ready'), 'log contains loader ready');
  assert(log.includes('renderer preload installed'), 'log contains renderer preload install');

  console.log('loader smoke test OK');
  console.log(`temp: ${temp}`);
  console.log(`log:  ${logFile}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
