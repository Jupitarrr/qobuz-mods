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
      enabled: { 'now-playing': false, 'last-played': true },
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

  // This is how Qobuz publishes progress: main -> renderer via webContents.send.
  win.webContents.send('player-refresh-music-info', {
    timestamp: Date.now(),
    position: 12.5,
    status: 'Playing',
    endOfFile: false,
  });

  const list = await fakeIpcMain.invoke('qobuzmods:mod-invoke', 'last-played', 'list');
  assert(list.albums.length === 1, 'last-played recorded one album');
  assert(list.albums[0].albumId === 'xne8h1xxlpfbc', 'album id recorded');
  assert(list.albums[0].albumTitle === 'Big Ideas', 'album title recorded');
  assert(list.albums[0].artist === 'Remi Wolf', 'artist recorded');
  assert(list.albums[0].playCount === 1, 'play count is one');

  const toggled = await fakeIpcMain.invoke('qobuzmods:set-enabled', 'now-playing', true);
  assert(toggled.restartRequired === true, 'toggling sets restartRequired');
  assert(
    toggled.mods.find((mod) => mod.id === 'now-playing').enabled === true,
    'now-playing enabled in config',
  );

  const doctor = await fakeIpcMain.invoke('qobuzmods:doctor');
  assert(doctor.player.hasTrack, 'doctor sees current track');
  assert(doctor.player.playing, 'doctor sees playing state');
  assert(doctor.mods.length >= 2, 'doctor lists mods');

  fakeApp.emit('before-quit');
  const dataFile = path.join(configDir, 'data', 'last-played', 'last-played.json');
  assert(fs.existsSync(dataFile), 'last-played.json written on quit');

  const log = fs.readFileSync(logFile, 'utf8');
  assert(log.includes('loader ready'), 'log contains loader ready');
  assert(log.includes('renderer preload installed'), 'log contains renderer preload install');

  console.log('loader smoke test OK');
  console.log(`temp: ${temp}`);
  console.log(`log:  ${logFile}`);
  console.log(`json: ${dataFile}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
