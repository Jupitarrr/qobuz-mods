'use strict';

// Qobuz Mods — main-process loader.
//
// The patcher prepends exactly one line to Qobuz's main-<platform>.js:
//
//   ;require("/absolute/path/to/runtime/loader.js");/*qobuz-mods*/
//
// This file runs before any Qobuz code. It must never throw: a broken mod or a
// bad assumption should degrade to "no mods", not "Qobuz will not start".

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { EventEmitter } = require('node:events');

const PACK_ROOT = path.resolve(__dirname, '..');
const MODS_DIR = path.join(PACK_ROOT, 'mods');
const PLATFORM = process.platform;

let VERSION = '0.1.0';
try {
  // Present in a source checkout, absent in the installed runtime.
  VERSION = require(path.join(PACK_ROOT, 'package.json')).version || VERSION;
} catch {
  // Keep the fallback.
}

function osConfigDir() {
  if (process.env.QOBUZ_MODS_CONFIG_DIR) {
    return path.resolve(process.env.QOBUZ_MODS_CONFIG_DIR);
  }
  switch (PLATFORM) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'QobuzMods');
    case 'win32':
      return path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        'QobuzMods',
      );
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
        'QobuzMods',
      );
  }
}

function osLogFile() {
  if (process.env.QOBUZ_MODS_LOG) return path.resolve(process.env.QOBUZ_MODS_LOG);
  switch (PLATFORM) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Logs', 'qobuz-mods.log');
    case 'win32':
      return path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'QobuzMods',
        'logs',
        'qobuz-mods.log',
      );
    default:
      return path.join(
        process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
        'qobuz-mods',
        'qobuz-mods.log',
      );
  }
}

const CONFIG_DIR = osConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DATA_DIR = path.join(CONFIG_DIR, 'data');
const LOG_FILE = osLogFile();

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Ignore; logging/writes will report the real problem.
  }
}

function rotateLog() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 5 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch {
    // Missing file or no permission.
  }
}

function formatArg(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function log(level, ...args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(formatArg).join(' ')}\n`;
  try {
    ensureDir(path.dirname(LOG_FILE));
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Logging must never break the app.
  }
  if (level === 'error' || level === 'warn') {
    try {
      // eslint-disable-next-line no-console
      console[level](`[qobuz-mods] ${args.map(formatArg).join(' ')}`);
    } catch {
      // Ignore.
    }
  }
}

function scopedLogger(id) {
  const make = (level) => (...args) => log(level, `[${id}]`, ...args);
  const fn = make('info');
  fn.info = make('info');
  fn.warn = make('warn');
  fn.error = make('error');
  fn.debug = make('debug');
  return fn;
}

// ---------------------------------------------------------------------------
// Duplicate-load guard
// ---------------------------------------------------------------------------

if (global.__qobuzModsLoader) {
  module.exports = global.__qobuzModsLoader;
  return;
}

let electron;
try {
  electron = require('electron');
} catch (error) {
  log('error', 'could not require electron', error);
  module.exports = { disabled: true };
  return;
}

const {
  app,
  ipcMain,
  BrowserWindow,
  globalShortcut,
  shell,
  dialog,
  session,
} = electron;

if (!app || !ipcMain) {
  log('error', 'electron main-process modules are unavailable');
  module.exports = { disabled: true };
  return;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  version: 1,
  enabled: {},
  options: {},
};

function loadConfig() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log('warn', 'could not parse config; using defaults', error.message);
    }
  }
  return {
    version: stored.version || DEFAULT_CONFIG.version,
    enabled: stored.enabled && typeof stored.enabled === 'object' ? { ...stored.enabled } : {},
    options: stored.options && typeof stored.options === 'object' ? { ...stored.options } : {},
  };
}

let config = loadConfig();
let configDirty = false;

function markConfigDirty() {
  configDirty = true;
}

function saveConfig() {
  if (!configDirty) return;
  ensureDir(CONFIG_DIR);
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, CONFIG_FILE);
    configDirty = false;
  } catch (error) {
    log('error', 'could not save config', error);
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  mods: new Map(),
  windows: new Set(),
  mainWindow: null,
  restartRequired: false,
  startedAt: Date.now(),
};

const PRELOAD_PATH = path.join(PACK_ROOT, 'runtime', 'renderer.js');
const wrappedSenders = new WeakSet();

const playerEvents = new EventEmitter();
playerEvents.setMaxListeners(50);

const playerState = {
  currentTrack: null,
  playing: false,
  position: 0,
  status: 'Stopped',
  endOfFile: false,
};

function emit(type, payload = {}) {
  const event = { type, at: Date.now(), ...payload };
  playerEvents.emit('event', event);
  playerEvents.emit(type, event);
  return event;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function seconds(value) {
  const n = num(value, 0);
  if (n <= 0) return 0;
  // The JUCE player reports seconds; some persisted values are milliseconds.
  return n > 10000 ? n / 1000 : n;
}

function existingFile(candidate) {
  try {
    const file = candidate.startsWith('file://') ? fileURLToPath(candidate) : candidate;
    if (path.isAbsolute(file) && fs.existsSync(file)) return file;
  } catch {
    // Not a usable path.
  }
  return '';
}

function qobuzUserData() {
  try {
    return app.getPath('userData');
  } catch {
    return '';
  }
}

function artworkFor(album, albumId) {
  const out = { path: '', url: '', expectedPath: '' };
  const image = album && album.image && typeof album.image === 'object' ? album.image : {};
  const assets = album && album.assetsAPI && typeof album.assetsAPI === 'object' ? album.assetsAPI : {};

  if (typeof assets.small === 'string' && /^https?:/i.test(assets.small)) {
    out.url = assets.small;
  } else if (typeof image.small === 'string' && /^https?:/i.test(image.small)) {
    out.url = image.small;
  }

  const userData = qobuzUserData();
  if (albumId && userData) {
    // Qobuz writes downloaded album covers here (see getCoverSmallImage() in
    // its own bundle). The file may not exist yet when a track starts, because
    // Qobuz kicks off the download asynchronously right after we see the load.
    out.expectedPath = path.join(userData, 'tmp', 'Assets', albumId, 'small_cover.png');
  }

  const candidates = [];
  if (out.expectedPath) {
    candidates.push(
      out.expectedPath,
      path.join(userData, 'tmp', 'Assets', albumId, 'large_cover.png'),
    );
  }
  for (const key of ['small', 'thumbnail', 'large']) {
    const value = image[key];
    if (typeof value === 'string' && value) candidates.push(value);
  }

  for (const candidate of candidates) {
    const file = existingFile(candidate);
    if (file) {
      out.path = file;
      break;
    }
  }
  return out;
}

// Album covers are downloaded by Qobuz asynchronously after player-load-music /
// player-switch-channel. Watch the expected file for a short while so the
// native now-playing item can be updated once the artwork actually exists.
let artworkWatch = null;

function cancelArtworkWatch() {
  if (!artworkWatch) return;
  clearTimeout(artworkWatch.timer);
  artworkWatch = null;
}

function isCurrentTrack(meta) {
  const track = playerState.currentTrack;
  if (!track || !meta) return false;
  return (
    track.id === meta.id &&
    track.albumId === meta.albumId &&
    track.title === meta.title
  );
}

function watchArtwork(meta) {
  cancelArtworkWatch();
  if (!meta || meta.artworkPath || !meta.artworkExpectedPath) return;

  const watch = { timer: null, expectedPath: meta.artworkExpectedPath };
  const deadline = Date.now() + 8000;
  artworkWatch = watch;

  const check = () => {
    if (artworkWatch !== watch) return;
    if (!isCurrentTrack(meta)) {
      artworkWatch = null;
      return;
    }

    const file = existingFile(watch.expectedPath);
    if (file) {
      const track = playerState.currentTrack;
      track.artworkPath = file;
      artworkWatch = null;
      log('debug', 'album artwork ready', file);
      emit('artwork', { track, artworkPath: file });
      return;
    }

    if (Date.now() >= deadline) {
      artworkWatch = null;
      log('debug', 'album artwork still missing', watch.expectedPath);
      return;
    }

    watch.timer = setTimeout(check, 200);
  };

  watch.timer = setTimeout(check, 100);
}

function describeTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const album = raw.album && typeof raw.album === 'object' ? raw.album : {};
  const performer =
    raw.performer && typeof raw.performer === 'object' ? raw.performer : null;
  const artistObj =
    (raw.artist && typeof raw.artist === 'object' && raw.artist) ||
    (Array.isArray(raw.artists) && raw.artists[0]) ||
    {};
  const artistName =
    (performer && typeof performer.name === 'string' && performer.name) ||
    (typeof raw.artist === 'string' && raw.artist) ||
    artistObj.name ||
    '';
  const albumId = album.id != null ? String(album.id) : '';
  const artwork = artworkFor(album, albumId);
  const version =
    raw.version && typeof raw.version === 'string' && raw.version.trim()
      ? ` (${raw.version.trim()})`
      : '';

  return {
    id: raw.id != null ? String(raw.id) : '',
    title: `${raw.title || raw.name || ''}${version}`.trim(),
    artist: String(artistName),
    album: String(album.title || ''),
    albumId,
    duration: seconds(raw.duration),
    artworkPath: artwork.path,
    artworkUrl: artwork.url,
    artworkExpectedPath: artwork.expectedPath,
    parentalWarning: Boolean(raw.parental_warning || album.parental_warning),
  };
}

// Tracks load through one of three paths:
//   player-load-music         normal play / manual skip
//   player-switch-channel     gapless advance to an already prepared track
//   external-player-state-update  cast/external player
// Only the first one carries the track metadata in its IPC payload, so the
// prepared next track is cached when Qobuz announces it.
let preparedNextTrack = null;
let lastTrackDedupe = '';
let lastTrackSignature = '';
let lastTrackAt = 0;

function setTrackFromRaw(raw, source, options = {}) {
  const meta = describeTrack(raw);
  if (!meta) return null;

  const now = Date.now();
  const signature = `${meta.id}|${meta.albumId}|${meta.title}`;
  const dedupe = options.dedupeKey ? String(options.dedupeKey) : '';

  if (dedupe) {
    if (dedupe === lastTrackDedupe) return null;
  } else if (options.dedupeSame) {
    if (signature === lastTrackSignature) return null;
  } else if (signature === lastTrackSignature && now - lastTrackAt < 2500) {
    // Guard against duplicate notifications for the same track.
    return null;
  }

  cancelArtworkWatch();
  lastTrackDedupe = dedupe;
  lastTrackSignature = signature;
  lastTrackAt = now;
  playerState.currentTrack = meta;
  playerState.playing = options.playing === true;
  playerState.position = Math.max(0, num(options.position, 0));

  if (config.options && config.options.__debugTrack === true) {
    log('debug', 'track object keys', Object.keys(raw));
  } else if (!global.__qobuzModsTrackLogged) {
    global.__qobuzModsTrackLogged = true;
    log('debug', 'first track object keys', Object.keys(raw));
  }

  const event = emit('track', {
    track: meta,
    playing: playerState.playing,
    source,
  });
  watchArtwork(meta);
  return event;
}

function observeOutgoing(channel, args) {
  if (channel === 'player-refresh-music-info') {
    const info = args && args[0];
    if (!info || typeof info !== 'object') return;

    const key = `${info.timestamp}|${info.position}|${info.status}|${info.endOfFile}`;
    if (key === playerState.lastProgressKey) return;
    playerState.lastProgressKey = key;

    const status = String(info.status || '');
    const lower = status.toLowerCase();
    let playing = playerState.playing;
    if (lower.includes('play')) playing = true;
    else if (lower.includes('pause') || lower.includes('stop')) playing = false;
    const stateName = lower.includes('stop')
      ? 'stopped'
      : playing
        ? 'playing'
        : 'paused';

    playerState.playing = playing;
    playerState.position = seconds(info.position);
    playerState.status = status;
    playerState.endOfFile = Boolean(info.endOfFile);

    emit('progress', {
      position: playerState.position,
      status,
      state: stateName,
      playing,
      endOfFile: playerState.endOfFile,
    });
  }
}

function wrapSender(target) {
  if (!target || wrappedSenders.has(target)) return;
  let original;
  try {
    original = target.send;
  } catch {
    return;
  }
  if (typeof original !== 'function') return;

  const wrapped = function wrappedSend(channel) {
    try {
      observeOutgoing(channel, Array.prototype.slice.call(arguments, 1));
    } catch (error) {
      log('error', 'send observer failed', error);
    }
    return original.apply(this, arguments);
  };

  try {
    target.send = wrapped;
  } catch {
    try {
      Object.defineProperty(target, 'send', {
        configurable: true,
        writable: true,
        value: wrapped,
      });
    } catch {
      return;
    }
  }
  wrappedSenders.add(target);
}

function isMainUi(url) {
  return typeof url === 'string' && /\/app\.html(?:[?#]|$)/.test(url);
}

function liveWebContents() {
  const out = [];
  for (const win of state.windows) {
    try {
      if (win.isDestroyed()) continue;
      const wc = win.webContents;
      if (wc && !wc.isDestroyed()) out.push(wc);
    } catch {
      // Ignore a window that vanished during iteration.
    }
  }
  return out;
}

function preferMainWebContents() {
  try {
    const win = state.mainWindow;
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      return win.webContents;
    }
  } catch {
    // Fall through.
  }
  const all = liveWebContents();
  return all.length > 0 ? all[0] : null;
}

function sendControl(command) {
  const wc = preferMainWebContents();
  if (!wc) {
    log('warn', 'sendControl: no live renderer', command);
    return false;
  }

  const normalized = String(command || '').toLowerCase();
  if (normalized === 'play' && playerState.playing) return true;
  if (normalized === 'pause' && !playerState.playing) return true;

  const map = {
    next: 'next',
    previous: 'previous',
    prev: 'previous',
    toggle: 'togglePlayPause',
    toggleplaypause: 'togglePlayPause',
    play: 'togglePlayPause',
    pause: 'togglePlayPause',
  };
  const mediaCommand = map[normalized];
  if (!mediaCommand) {
    log('warn', 'sendControl: unknown command', command);
    return false;
  }

  try {
    wc.send('media-controls', mediaCommand);
    log('debug', 'sent media-controls', mediaCommand);
    return true;
  } catch (error) {
    log('error', 'sendControl failed', error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Renderer injection
// ---------------------------------------------------------------------------

function rendererSources() {
  const sources = [];
  const add = (id, file) => {
    try {
      if (!fs.existsSync(file)) return;
      sources.push({ id, code: fs.readFileSync(file, 'utf8') });
    } catch (error) {
      log('error', 'could not read renderer source', id, file, error);
    }
  };

  add('mods-menu', path.join(MODS_DIR, 'mods-menu', 'renderer.js'));

  for (const mod of state.mods.values()) {
    if (!mod.enabled || !mod.platformOk) continue;
    if (mod.id === 'mods-menu') continue;
    if (!mod.manifest || !mod.manifest.renderer) continue;
    add(mod.id, path.join(mod.dir, String(mod.manifest.renderer)));
  }

  return sources;
}

function installPreload() {
  if (!session || !session.defaultSession) {
    log('warn', 'session.defaultSession is unavailable; cannot install renderer preload');
    return false;
  }

  const ses = session.defaultSession;
  const preloads = ses.getPreloads();
  if (!preloads.includes(PRELOAD_PATH)) {
    ses.setPreloads([...preloads, PRELOAD_PATH]);
    log('info', 'renderer preload installed', ses.getPreloads());
  }
  return true;
}

function checkRenderer(wc) {
  setTimeout(() => {
    try {
      const check = wc.executeJavaScript('Boolean(window.__qobuzModsMenuInstalled)');
      if (check && typeof check.then === 'function') {
        check
          .then((installed) => {
            if (installed) log('info', 'mods menu present in renderer');
            else log('warn', 'mods menu missing in renderer; check the preload log');
          })
          .catch((error) => log('warn', 'renderer menu check failed', error));
      }
    } catch (error) {
      log('warn', 'renderer menu check threw', error);
    }
  }, 1000);
}

function attachWindow(win) {
  if (!win || state.windows.has(win)) return;
  state.windows.add(win);

  let wc;
  try {
    wc = win.webContents;
  } catch {
    return;
  }
  if (!wc) return;

  wrapSender(wc);
  // Some Electron/Quobuz builds expose BrowserWindow.send as an alias.
  try {
    if (typeof win.send === 'function' && win.send !== wc.send) wrapSender(win);
  } catch {
    // Ignore.
  }

  wc.on('did-finish-load', () => {
    try {
      if (isMainUi(wc.getURL())) {
        state.mainWindow = win;
        try {
          log('debug', 'webPreferences', wc.getLastWebPreferences());
        } catch (error) {
          log('debug', 'webPreferences unavailable', error.message);
        }
        checkRenderer(wc);
      }
    } catch (error) {
      log('error', 'did-finish-load handler failed', error);
    }
  });

  win.on('closed', () => {
    state.windows.delete(win);
    if (state.mainWindow === win) state.mainWindow = null;
  });

  // If the window was already loading/loaded before we attached.
  try {
    if (!wc.isLoading() && isMainUi(wc.getURL())) {
      state.mainWindow = win;
      checkRenderer(wc);
    }
  } catch {
    // Ignore.
  }
}

// ---------------------------------------------------------------------------
// Player IPC (no Qobuz source patches needed)
// ---------------------------------------------------------------------------

function installPlayerIpc() {
  // Payload order from the renderer:
  //   player-load-music(loadId, trackMetadata, fileUrlData, positionSeconds)
  // The metadata object is the one Qobuz's own notifyOperatingSystem consumes.
  ipcMain.on('player-load-music', (event, loadId, trackMetadata) => {
    try {
      preparedNextTrack = null;
      // A unique load id lets the same track be replayed without being
      // mistaken for a duplicate notification.
      setTrackFromRaw(trackMetadata, 'player-load-music', {
        dedupeKey: loadId != null ? `load:${loadId}` : '',
      });
    } catch (error) {
      log('error', 'player-load-music handling failed', error);
    }
  });

  // Qobuz preloads the next queue item on the "next" player:
  //   player-prepare-next-track(requestId, trackMetadata, fileUrlData)
  // Gapless playback later switches to it without sending player-load-music.
  ipcMain.on('player-prepare-next-track', (event, requestId, trackMetadata, fileUrlData) => {
    try {
      preparedNextTrack =
        trackMetadata && fileUrlData
          ? { requestId: requestId != null ? String(requestId) : '', track: trackMetadata }
          : null;
    } catch (error) {
      log('error', 'player-prepare-next-track handling failed', error);
    }
  });

  ipcMain.on('player-switch-channel', (event, requestId) => {
    try {
      const prepared = preparedNextTrack;
      preparedNextTrack = null;
      if (!prepared || !prepared.track) {
        log('warn', 'gapless switch without a prepared track; now playing may stay stale');
        return;
      }
      setTrackFromRaw(prepared.track, 'player-switch-channel', {
        dedupeKey: prepared.requestId ? `switch:${prepared.requestId}` : '',
        playing: true,
      });
      playerState.playing = true;
    } catch (error) {
      log('error', 'player-switch-channel handling failed', error);
    }
  });

  // Cast / external player updates carry the full mapped track.
  ipcMain.on('external-player-state-update', (event, payload) => {
    try {
      const info = payload && typeof payload === 'object' ? payload : {};
      const playingState = String(info.playingState || '');
      if (info.currentTrack) {
        const playing = playingState === 'play';
        const emitted = setTrackFromRaw(info.currentTrack, 'external-player-state-update', {
          dedupeSame: true,
          playing,
        });
        if (!emitted) {
          // The track did not change; still forward play/pause/stop changes.
          playerState.playing = playing;
          emit('state', {
            state: playingState === 'stopped' ? 'stopped' : playing ? 'playing' : 'paused',
            playing,
          });
        }
      }
    } catch (error) {
      log('error', 'external-player-state-update handling failed', error);
    }
  });

  ipcMain.on('player-play-music', () => {
    playerState.playing = true;
    emit('state', { state: 'playing', playing: true });
  });

  ipcMain.on('player-pause-music', () => {
    playerState.playing = false;
    emit('state', { state: 'paused', playing: false });
  });

  ipcMain.on('player-stop-music', () => {
    playerState.playing = false;
    emit('state', { state: 'stopped', playing: false });
  });

  const clear = (source) => {
    cancelArtworkWatch();
    playerState.currentTrack = null;
    playerState.playing = false;
    playerState.position = 0;
    playerState.status = 'Stopped';
    preparedNextTrack = null;
    lastTrackDedupe = '';
    lastTrackSignature = '';
    emit('clear', { source });
  };

  ipcMain.on('player-close-music', () => clear('player-close-music'));
  ipcMain.on('player-close-all-music', () => clear('player-close-all-music'));
}

// ---------------------------------------------------------------------------
// Mods
// ---------------------------------------------------------------------------

function discoverMods() {
  let entries = [];
  try {
    entries = fs.readdirSync(MODS_DIR, { withFileTypes: true });
  } catch (error) {
    log('warn', 'could not read mods directory', MODS_DIR, error.message);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(MODS_DIR, entry.name);
    const manifestPath = path.join(dir, 'mod.json');
    if (!fs.existsSync(manifestPath)) continue;

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      log('error', 'invalid mod manifest', manifestPath, error.message);
      continue;
    }

    const id = String(manifest.id || entry.name);
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
      log('error', 'invalid mod id', id, manifestPath);
      continue;
    }

    const platforms = Array.isArray(manifest.platforms) ? manifest.platforms : null;
    const platformOk = !platforms || platforms.includes(PLATFORM);

    if (config.enabled[id] === undefined && !manifest.core) {
      config.enabled[id] = manifest.defaultEnabled !== false;
      markConfigDirty();
    }

    const enabled = manifest.core
      ? true
      : platformOk && config.enabled[id] !== false;

    state.mods.set(id, {
      id,
      dir,
      manifest,
      enabled,
      platformOk,
      active: false,
      error: null,
      exported: null,
      api: { methods: new Map() },
    });
  }

  saveConfig();
}

function orderMods() {
  const all = [...state.mods.values()];
  const byId = new Map(all.map((mod) => [mod.id, mod]));
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];

  const visit = (mod) => {
    if (visited.has(mod.id)) return;
    if (visiting.has(mod.id)) {
      log('warn', 'mod dependency cycle', mod.id);
      return;
    }
    visiting.add(mod.id);
    for (const dep of Array.isArray(mod.manifest.requires) ? mod.manifest.requires : []) {
      const target = byId.get(dep);
      if (!target) {
        log('warn', `mod ${mod.id} requires missing mod ${dep}`);
        continue;
      }
      visit(target);
    }
    visiting.delete(mod.id);
    visited.add(mod.id);
    ordered.push(mod);
  };

  for (const mod of all) {
    if (mod.enabled) visit(mod);
  }
  return ordered;
}

function createContext(mod) {
  const dataDir = path.join(DATA_DIR, mod.id);
  ensureDir(dataDir);
  const logger = scopedLogger(mod.id);

  const player = {
    get currentTrack() {
      return playerState.currentTrack;
    },
    get playing() {
      return playerState.playing;
    },
    get position() {
      return playerState.position;
    },
    get status() {
      return playerState.status;
    },
    on(type, handler) {
      const wrapped = (event) => {
        if (event.type === type) handler(event);
      };
      playerEvents.on('event', wrapped);
      return () => playerEvents.off('event', wrapped);
    },
    sendControl,
  };

  return {
    id: mod.id,
    version: VERSION,
    manifest: mod.manifest,
    dir: mod.dir,
    platform: PLATFORM,
    electron,
    app,
    ipcMain,
    shell,
    dialog,
    BrowserWindow,
    globalShortcut,
    player,
    config: {
      get(key) {
        const values = config.options[mod.id] || {};
        return values[key];
      },
      all() {
        return { ...(config.options[mod.id] || {}) };
      },
      set(key, value) {
        if (!config.options[mod.id]) config.options[mod.id] = {};
        config.options[mod.id][key] = value;
        markConfigDirty();
        saveConfig();
      },
    },
    paths: {
      packRoot: PACK_ROOT,
      modsDir: MODS_DIR,
      configDir: CONFIG_DIR,
      configFile: CONFIG_FILE,
      dataDir,
      logFile: LOG_FILE,
      qobuzUserData: (() => {
        try {
          return app.getPath('userData');
        } catch {
          return '';
        }
      })(),
    },
    onPlayerEvent(handler) {
      playerEvents.on('event', handler);
      return () => playerEvents.off('event', handler);
    },
    ipc: {
      handle(method, handler) {
        mod.api.methods.set(String(method), handler);
      },
      send(channel, ...args) {
        for (const wc of liveWebContents()) {
          try {
            wc.send(channel, ...args);
          } catch {
            // Ignore a renderer that vanished.
          }
        }
      },
    },
    log: logger,
  };
}

function loadMods() {
  discoverMods();

  for (const mod of orderMods()) {
    if (!mod.platformOk) {
      mod.error = `not supported on ${PLATFORM}`;
      log('info', `skipping ${mod.id}: not supported on ${PLATFORM}`);
      continue;
    }
    if (!mod.manifest.main) {
      // Renderer-only mods have nothing to activate in the main process. Mark
      // them active so a later disable/enable is correctly reported as pending.
      if (mod.manifest.renderer) mod.active = mod.enabled;
      continue;
    }

    const mainFile = path.join(mod.dir, String(mod.manifest.main));
    if (!fs.existsSync(mainFile)) {
      mod.error = `main file not found: ${mainFile}`;
      log('error', `mod ${mod.id}: ${mod.error}`);
      continue;
    }

    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const exported = require(mainFile);
      mod.exported = exported;
      const context = createContext(mod);
      const activate =
        typeof exported === 'function'
          ? exported
          : exported && typeof exported.activate === 'function'
            ? exported.activate.bind(exported)
            : null;

      if (!activate) {
        throw new Error('mod does not export activate(ctx)');
      }

      const result = activate(context);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          mod.error = String(error && error.stack ? error.stack : error);
          log('error', `mod ${mod.id} async activation failed`, error);
        });
      }

      mod.active = true;
      mod.error = null;
      log('info', `loaded mod ${mod.id}@${mod.manifest.version || '?'}`);
    } catch (error) {
      mod.active = false;
      mod.error = String(error && error.stack ? error.stack : error);
      log('error', `mod ${mod.id} failed to load`, error);
    }
  }
}

function publicMods() {
  const coreWeight = (mod) => (mod.manifest && mod.manifest.core ? 0 : 1);
  return [...state.mods.values()]
    .sort((a, b) => {
      const c = coreWeight(a) - coreWeight(b);
      if (c !== 0) return c;
      return String(a.manifest.name || a.id).localeCompare(String(b.manifest.name || b.id));
    })
    .map((mod) => ({
      id: mod.id,
      name: String(mod.manifest.name || mod.id),
      version: String(mod.manifest.version || '0.0.0'),
      description: String(mod.manifest.description || ''),
      author: mod.manifest.author ? String(mod.manifest.author) : '',
      core: Boolean(mod.manifest.core),
      enabled: mod.enabled,
      active: mod.active,
      error: mod.error,
      platformOk: mod.platformOk,
      platforms: Array.isArray(mod.manifest.platforms) ? mod.manifest.platforms : null,
      requiresRestart: mod.manifest.requiresRestart !== false,
      hasRenderer: Boolean(mod.manifest.renderer),
    }));
}

function computeRestartRequired() {
  return [...state.mods.values()].some((mod) => {
    if (mod.manifest.core) return false;
    if (!mod.platformOk) return false;
    if (!mod.manifest.main && !mod.manifest.renderer) return false;
    // A mod that failed to load is not a pending toggle; it is an error.
    if (mod.error) return false;
    return mod.enabled !== mod.active;
  });
}

function setModEnabled(id, enabled) {
  const mod = state.mods.get(id);
  if (!mod) throw new Error(`unknown mod: ${id}`);
  if (mod.manifest.core) throw new Error(`${id} is a core mod and cannot be disabled`);
  if (enabled && !mod.platformOk) {
    throw new Error(`${id} is not supported on ${PLATFORM}`);
  }

  config.enabled[id] = Boolean(enabled);
  mod.enabled = Boolean(enabled);
  state.restartRequired = computeRestartRequired();
  markConfigDirty();
  saveConfig();
  log(
    'info',
    `mod ${id} ${enabled ? 'enabled' : 'disabled'}` +
      (state.restartRequired ? ' (restart required)' : ''),
  );
  return {
    mods: publicMods(),
    restartRequired: state.restartRequired,
  };
}

// ---------------------------------------------------------------------------
// IPC bridge for the renderer menu and mods
// ---------------------------------------------------------------------------

function installBridgeIpc() {
  const handle = (channel, fn) => {
    try {
      ipcMain.handle(channel, fn);
    } catch (error) {
      log('warn', `could not register ${channel}`, error.message);
    }
  };

  handle('qobuzmods:list', () => ({
    mods: publicMods(),
    restartRequired: state.restartRequired,
    version: VERSION,
  }));

  handle('qobuzmods:renderer-sources', () => rendererSources());

  ipcMain.on('qobuzmods:renderer-log', (event, level, message) => {
    const allowed = ['debug', 'info', 'warn', 'error'];
    const safeLevel = allowed.includes(String(level)) ? String(level) : 'info';
    log(safeLevel, '[renderer]', String(message));
  });

  handle('qobuzmods:set-enabled', (event, id, enabled) => setModEnabled(String(id), Boolean(enabled)));

  handle('qobuzmods:get-config', () => ({
    version: config.version,
    enabled: { ...config.enabled },
    options: JSON.parse(JSON.stringify(config.options)),
  }));

  handle('qobuzmods:open-mods-folder', async () => {
    ensureDir(MODS_DIR);
    const error = await shell.openPath(MODS_DIR);
    if (error) throw new Error(error);
    return MODS_DIR;
  });

  handle('qobuzmods:open-config-folder', async () => {
    ensureDir(CONFIG_DIR);
    const error = await shell.openPath(CONFIG_DIR);
    if (error) throw new Error(error);
    return CONFIG_DIR;
  });

  handle('qobuzmods:open-external', async (event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('only http(s) URLs may be opened');
    }
    await shell.openExternal(url);
    return true;
  });

  handle('qobuzmods:show-log', () => {
    if (fs.existsSync(LOG_FILE)) {
      shell.showItemInFolder(LOG_FILE);
    } else {
      ensureDir(path.dirname(LOG_FILE));
      fs.writeFileSync(LOG_FILE, '', 'utf8');
      shell.showItemInFolder(LOG_FILE);
    }
    return LOG_FILE;
  });

  handle('qobuzmods:restart', () => {
    setImmediate(() => restartApp());
    return true;
  });

  handle('qobuzmods:mod-invoke', async (event, id, method, ...args) => {
    const mod = state.mods.get(String(id));
    if (!mod) throw new Error(`unknown mod: ${id}`);
    if (!mod.enabled || !mod.active) throw new Error(`mod ${id} is not active`);
    const fn = mod.api.methods.get(String(method));
    if (typeof fn !== 'function') throw new Error(`mod ${id} has no method ${method}`);
    return fn(...args);
  });

  handle('qobuzmods:doctor', () => doctorSnapshot());
}

function restartApp() {
  try {
    log('info', 'restart requested');
    saveConfig();
    app.relaunch();
    app.exit(0);
  } catch (error) {
    log('error', 'restart failed', error);
  }
}

function doctorSnapshot() {
  let appInfo = {};
  try {
    appInfo = {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      userData: app.getPath('userData'),
      locale: app.getLocale(),
    };
  } catch (error) {
    appInfo = { error: String(error) };
  }

  return {
    version: VERSION,
    platform: PLATFORM,
    pid: process.pid,
    uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
    app: appInfo,
    paths: {
      packRoot: PACK_ROOT,
      modsDir: MODS_DIR,
      configDir: CONFIG_DIR,
      configFile: CONFIG_FILE,
      dataDir: DATA_DIR,
      logFile: LOG_FILE,
    },
    player: {
      hasTrack: Boolean(playerState.currentTrack),
      track: playerState.currentTrack,
      playing: playerState.playing,
      position: playerState.position,
      status: playerState.status,
    },
    mods: publicMods(),
    restartRequired: state.restartRequired,
    windows: state.windows.size,
  };
}

// ---------------------------------------------------------------------------
// Public global bridge (for main-process mods and debugging)
// ---------------------------------------------------------------------------

const api = {
  version: VERSION,
  packRoot: PACK_ROOT,
  modsDir: MODS_DIR,
  configDir: CONFIG_DIR,
  logFile: LOG_FILE,
  list: publicMods,
  restartRequired: () => state.restartRequired,
  setEnabled: setModEnabled,
  getConfig: () => JSON.parse(JSON.stringify(config)),
  restart: restartApp,
  doctor: doctorSnapshot,
  player: {
    get currentTrack() {
      return playerState.currentTrack;
    },
    get playing() {
      return playerState.playing;
    },
    get position() {
      return playerState.position;
    },
    get status() {
      return playerState.status;
    },
    sendControl,
    on: (type, handler) => {
      const wrapped = (event) => {
        if (event.type === type) handler(event);
      };
      playerEvents.on('event', wrapped);
      return () => playerEvents.off('event', wrapped);
    },
    onAny: (handler) => {
      playerEvents.on('event', handler);
      return () => playerEvents.off('event', handler);
    },
  },
};

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function init() {
  rotateLog();
  ensureDir(CONFIG_DIR);
  ensureDir(DATA_DIR);

  log('info', 'qobuz-mods loader starting', {
    version: VERSION,
    platform: PLATFORM,
    packRoot: PACK_ROOT,
    configFile: CONFIG_FILE,
    logFile: LOG_FILE,
    electron: process.versions.electron,
    node: process.versions.node,
  });

  // Register these before Qobuz creates windows or registers its own handlers.
  app.on('browser-window-created', (event, win) => {
    try {
      attachWindow(win);
    } catch (error) {
      log('error', 'browser-window-created handler failed', error);
    }
  });

  installPlayerIpc();
  installBridgeIpc();

  // The main window's page loses Node globals after the bundle loads, so the
  // renderer bridge must be installed as a preload before the window exists.
  try {
    if (!installPreload()) {
      app.whenReady().then(() => {
        try {
          installPreload();
        } catch (error) {
          log('error', 'could not install renderer preload after ready', error);
        }
      });
    }
  } catch (error) {
    log('debug', 'default session not ready yet; preload will be installed after ready', error.message);
    app.whenReady().then(() => {
      try {
        installPreload();
      } catch (retryError) {
        log('error', 'could not install renderer preload after ready', retryError);
      }
    });
  }

  loadMods();
  state.restartRequired = computeRestartRequired();

  global.__qobuzMods = api;
  global.__qobuzModsLoader = api;

  app.on('before-quit', () => {
    try {
      saveConfig();
      cancelArtworkWatch();
      for (const mod of state.mods.values()) {
        if (!mod.active || !mod.exported) continue;
        const deactivate =
          typeof mod.exported === 'function' ? null : mod.exported.deactivate;
        if (typeof deactivate === 'function') {
          try {
            deactivate();
          } catch (error) {
            log('error', `mod ${mod.id} deactivate failed`, error);
          }
        }
      }
      playerEvents.emit('event', { type: 'quit', at: Date.now() });
    } catch (error) {
      log('error', 'before-quit hook failed', error);
    }
  });

  log('info', 'loader ready', {
    mods: publicMods().map((m) => `${m.id}:${m.enabled ? 'on' : 'off'}${m.error ? ':error' : ''}`),
  });
}

try {
  init();
} catch (error) {
  log('error', 'loader initialization failed', error);
}

module.exports = api;
