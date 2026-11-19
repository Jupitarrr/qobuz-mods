'use strict';

// Native macOS Now Playing integration.
//
// Data comes from the loader's runtime player bridge (IPC + webContents.send
// observation), so this mod does not require any Qobuz source patches beyond the
// single loader require line.

const fs = require('node:fs');
const path = require('node:path');

const MEDIA_KEYS = ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack'];

let native = null;
let restoreShortcuts = null;
let current = null;

function findAddon() {
  const candidates = [
    path.join(__dirname, 'qobuz-nowplaying.node'),
    path.join(__dirname, 'native', 'build', 'qobuz-nowplaying.node'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'qobuz-nowplaying.node is missing. Run `npm run build:native` (requires Xcode ' +
      'Command Line Tools) and re-run the patcher.',
  );
}

function suppressStockMediaKeys(ctx) {
  const gs = ctx.globalShortcut;
  if (!gs || typeof gs.register !== 'function') return () => {};

  const original = gs.register;
  try {
    gs.__qobuzModsOriginalRegister = gs.__qobuzModsOriginalRegister || original;
    gs.register = function qobuzModsRegister(accelerator, callback) {
      if (MEDIA_KEYS.includes(accelerator)) {
        ctx.log.info('suppressed stock media key registration', accelerator);
        return true;
      }
      return original.call(this, accelerator, callback);
    };
  } catch (error) {
    ctx.log.warn('could not wrap globalShortcut.register', error);
  }

  const unregister = () => {
    for (const key of MEDIA_KEYS) {
      try {
        gs.unregister(key);
      } catch {
        // Not registered.
      }
    }
  };

  try {
    if (ctx.app.isReady && ctx.app.isReady()) {
      setTimeout(unregister, 0);
    } else {
      ctx.app.whenReady().then(() => setTimeout(unregister, 500));
    }
  } catch {
    // Ignore.
  }

  return () => {
    try {
      if (gs.__qobuzModsOriginalRegister) {
        gs.register = gs.__qobuzModsOriginalRegister;
        delete gs.__qobuzModsOriginalRegister;
      }
    } catch {
      // Ignore.
    }
  };
}

function stateFor(event) {
  if (event.type === 'state') return event.state;
  if (event.type === 'progress') return event.state;
  if (event.type === 'track') return event.playing ? 'playing' : 'paused';
  return 'stopped';
}

function rateFor(event, ctx) {
  const playing =
    event.type === 'track' ? Boolean(event.playing) : Boolean(ctx.player.playing);
  return playing ? 1.0 : 0.0;
}

function applyTrack(event, ctx) {
  if (!native || !event.track) return;
  current = event.track;
  const state = stateFor(event);
  const rate = rateFor(event, ctx);

  native.setTrack({
    title: current.title,
    artist: current.artist,
    album: current.album,
    duration: current.duration,
    elapsed: 0,
    rate,
    state,
    artworkPath: current.artworkPath || '',
  });

  ctx.log.info('now playing', {
    title: current.title,
    artist: current.artist,
    album: current.album,
    duration: current.duration,
    state,
  });
}

function applyProgress(event, ctx) {
  if (!native) return;
  const playing = Boolean(event.playing);
  const state = stateFor(event);
  const duration = current ? current.duration : 0;

  native.setProgress({
    elapsed: Number(event.position) || 0,
    duration,
    rate: playing ? 1.0 : 0.0,
    state,
  });
}

function applyState(event, ctx) {
  if (!native) return;
  const state = stateFor(event);
  const playing = state === 'playing';
  native.setState({
    state,
    rate: playing ? 1.0 : 0.0,
  });
}

module.exports.activate = function activate(ctx) {
  if (ctx.platform !== 'darwin') {
    ctx.log.info(`now-playing: no native backend for ${ctx.platform} yet; leaving mod idle`);
    return;
  }

  const addonPath = findAddon();
  // eslint-disable-next-line import/no-dynamic-require, global-require
  native = require(addonPath);
  ctx.log.info('native addon loaded', addonPath);

  native.init((command) => {
    ctx.log.info('remote command', command);
    const ok = ctx.player.sendControl(command);
    if (!ok) ctx.log.warn('remote command could not be delivered', command);
  });

  restoreShortcuts = suppressStockMediaKeys(ctx);

  ctx.onPlayerEvent((event) => {
    try {
      switch (event.type) {
        case 'track':
          applyTrack(event, ctx);
          break;
        case 'progress':
          applyProgress(event, ctx);
          break;
        case 'state':
          applyState(event, ctx);
          break;
        case 'clear':
          current = null;
          native.clear();
          break;
        case 'quit':
          if (native) native.clear();
          break;
        default:
          break;
      }
    } catch (error) {
      ctx.log.error('player event handling failed', error);
    }
  });

  ctx.ipc.handle('status', () => ({
    native: Boolean(native),
    addonPath,
    current,
    playing: ctx.player.playing,
    position: ctx.player.position,
    status: ctx.player.status,
  }));
};

module.exports.deactivate = function deactivate() {
  try {
    if (restoreShortcuts) restoreShortcuts();
    restoreShortcuts = null;
  } catch {
    // Ignore.
  }
  try {
    if (native) native.clear();
  } catch {
    // Ignore teardown errors.
  }
  native = null;
  current = null;
};
