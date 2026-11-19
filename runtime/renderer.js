'use strict';

// Qobuz Mods — renderer preload.
//
// This file is installed with session.setPreloads() before the main window is
// created. That matters: Qobuz removes Node globals (`require`, `process`) from
// the page after its bundle loads, so post-load executeJavaScript cannot use
// require(). A preload runs early enough to capture ipcRenderer and evaluate
// renderer mods with the preload's own `require` in scope.
//
// With Qobuz's webPreferences (contextIsolation:false, nodeIntegration:true,
// sandbox:false) the preload and page share the same window, so the menu can
// build DOM directly and expose window.__qobuzModsRenderer for page devtools.

const { ipcRenderer } = require('electron');

const VERSION = '0.1.0';

function formatArg(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sendLog(level, ...args) {
  try {
    ipcRenderer.send('qobuzmods:renderer-log', level, args.map(formatArg).join(' '));
  } catch {
    // Never break the renderer because logging failed.
  }
}

function isMainUi() {
  try {
    return /\/app\.html(?:[?#]|$)/.test(window.location.href);
  } catch {
    return false;
  }
}

if (!window.__qobuzModsPreload) {
  window.__qobuzModsPreload = true;

  const invoke = (method, ...args) =>
    ipcRenderer.invoke(`qobuzmods:${String(method)}`, ...args);

  // The menu and renderer mods use this narrow bridge. They do not need direct
  // access to require/ipcRenderer.
  window.__qobuzModsRenderer = {
    version: VERSION,
    invoke,
    ipcRenderer,
  };

  window.__qobuzMods = {
    invoke,
    list: () => invoke('list'),
    doctor: () => invoke('doctor'),
  };

  async function installRendererMods() {
    if (!isMainUi()) return;

    try {
      const sources = await invoke('renderer-sources');
      if (!Array.isArray(sources)) {
        sendLog('warn', 'renderer-sources returned a non-array');
        return;
      }

      for (const source of sources) {
        if (!source || typeof source.code !== 'string') continue;
        try {
          // Direct eval: keeps this preload's `require` in scope so renderer
          // mods that need Node can use it too.
          eval(source.code); // eslint-disable-line no-eval
          sendLog('info', `renderer source loaded: ${source.id}`);
        } catch (error) {
          sendLog(
            'error',
            `renderer source failed: ${source.id}: ${error && error.stack ? error.stack : error}`,
          );
        }
      }
      sendLog('info', 'renderer mods installed');
    } catch (error) {
      sendLog(
        'error',
        `renderer installation failed: ${error && error.stack ? error.stack : error}`,
      );
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', installRendererMods, { once: true });
  } else {
    installRendererMods();
  }
}
