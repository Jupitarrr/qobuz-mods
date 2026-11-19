# Qobuz Mods

A Spicetify-style modding framework for **Qobuz Desktop**. Mods live outside the app
bundle, the patcher injects a single loader line into Qobuz's writable main JS file, and an
in-app **Mods** panel lets you enable/disable them.

Status: **macOS first iteration working.** The scratch app loads the framework, shows the
mods menu, publishes Now Playing metadata, and records last-played albums. Windows
scaffolding exists, but Windows is **not claimed as supported** until tested.

See [`FINDINGS.md`](FINDINGS.md) for the full investigation report and patch strategy.

## What works today

- Non-destructive patcher: copies the stock app, backs up the main JS, injects one require
  line, and ad-hoc re-signs the copy. `/Applications/Qobuz.app` is never modified.
- Runtime loader with config, logging, per-mod error isolation, dependency ordering, and a
  narrow IPC bridge.
- In-app **Mods** panel: list mods, enable/disable, restart-required state, open mods folder,
  view log, restart Qobuz, and a **Last played** tab.
- **Now Playing** (macOS): track metadata, artwork, duration, elapsed time, play/pause state,
  and next/previous/toggle from Control Center / media keys. Uses the existing
  `MPNowPlayingInfoCenter` / `MPRemoteCommandCenter` N-API addon.
- **Last Played**: records album starts from the player bridge and lists albums by most recent
  play. Independent of favorites.
- `doctor`, `patch`, `restore`, `update`, `list`, and `build-native` commands.
- Headless loader smoke test (`npm run test:smoke`).

## Quick start (development, scratch copy)

```sh
cd ~/git/qobuz-mods
./scripts/build-native.sh
node bin/qobuz-mod.js patch --dev --app ".scratch/Qobuz Dev.app"
open ".scratch/Qobuz Dev.app"
```

`--dev` injects the repo's `runtime/loader.js` and loads mods from the repo, so edits to the
loader/mods only need an app restart, not a re-patch. Config and data still live in
`~/Library/Application Support/QobuzMods/`.

Quit the stock `/Applications/Qobuz.app` first: both apps share the Qobuz profile and Electron
singleton lock. The framework does **not** kill a running Qobuz for you.

## Install (copy + patch)

```sh
cd ~/git/qobuz-mods
./scripts/build-native.sh
./install.sh
open "$HOME/Applications/Qobuz Mod.app"
```

The default target is `~/Applications/Qobuz Mod.app` (no sudo). The installer:

1. builds the native Now Playing addon if needed;
2. copies `/Applications/Qobuz.app` to the target (unless it already exists);
3. installs `runtime/` and first-party mods into
   `~/Library/Application Support/QobuzMods/`;
4. sets a distinct bundle id and display name, injects the loader, and ad-hoc signs the copy;
5. registers the result with LaunchServices.

Useful options:

```sh
node bin/qobuz-mod.js patch --app "/path/to/Qobuz Mod.app"
node bin/qobuz-mod.js patch --refresh          # re-copy the stock app, then patch
node bin/qobuz-mod.js update                   # same as patch --refresh --force
node bin/qobuz-mod.js restore --app "..."      # restore original main JS + re-sign
node bin/qobuz-mod.js doctor  --app "..."      # full diagnostic report
node bin/qobuz-mod.js list                     # installed mods
```

`doctor` reports app/Electron versions, paths, injection and backup state, codesign status,
config, mods, running processes, and recent log errors.

## How it works

### One-line injection

The patcher backs up the original `main-darwin.js` to `main-darwin.js.qobuzmod-backup` and
prepends:

```js
;require("/absolute/path/to/runtime/loader.js");/*qobuz-mods*/
```

That is the **only** source change. Re-running the patcher restores the backup first, then
re-applies, so it is idempotent. If Qobuz updates in place, the patcher detects the version
change and refreshes its backup.

### Runtime player bridge

The loader runs before Qobuz and observes the app's own IPC instead of patching player call
sites:

| Data | Mechanism |
| --- | --- |
| Track metadata | `ipcMain.on("player-load-music", (event, loadId, trackMetadata, ...))` |
| Play/pause/stop | `ipcMain.on("player-play-music" / "player-pause-music" / "player-stop-music")` |
| Progress | wraps `webContents.send` and observes `player-refresh-music-info` |
| Clear | `ipcMain.on("player-close-music" / "player-close-all-music")` |
| Next/previous/toggle | `webContents.send("media-controls", "next" / "previous" / "togglePlayPause")` |

This is cleaner than patching `notifyOperatingSystem`, `sendMusicInfo`, and
`initEventListener` (the old mod's six insertions). It also stays out of Qobuz's webpack
modules; replacing module `80725 → 28625` on macOS would only capture Touch Bar metadata and
not progress.

### Renderer preload

Qobuz's main window is created with `contextIsolation:false`, `nodeIntegration:true`, and
`sandbox:false`, but the page loses `require`/`process` after its bundle loads. Post-load
`executeJavaScript` therefore cannot `require('electron')`.

The loader installs `runtime/renderer.js` with
`session.defaultSession.setPreloads([...existing, runtime/renderer.js])` on `app.whenReady`,
before Qobuz creates the window. The preload:

- captures `ipcRenderer`;
- exposes `window.__qobuzModsRenderer` and `window.__qobuzMods`;
- asks the main process for enabled renderer sources via `qobuzmods:renderer-sources`;
- evals the menu and any renderer mods with the preload's own `require` in scope.

The menu is a core mod (`mods/mods-menu/renderer.js`) and cannot be disabled.

## Layout

```
bin/qobuz-mod.js            CLI: patch / restore / update / doctor / list / build-native
src/patcher/                paths, backup, injection, plist, codesign, runtime install
runtime/loader.js           injected main-process loader + player bridge + IPC
runtime/renderer.js         renderer preload (bridge + renderer mod eval)
mods/now-playing/           macOS MPNowPlayingInfoCenter addon + main mod
mods/last-played/           local album history + IPC list/clear
mods/mods-menu/             core in-app menu
scripts/build-native.sh     builds the macOS N-API addon
test/loader-smoke.js        headless fake-Electron loader test
```

## Paths

| Platform | Config / mods / data | Log |
| --- | --- | --- |
| macOS | `~/Library/Application Support/QobuzMods/` | `~/Library/Logs/qobuz-mods.log` |
| Windows | `%APPDATA%\QobuzMods\` | `%LOCALAPPDATA%\QobuzMods\logs\qobuz-mods.log` |

```
QobuzMods/
  config.json          { version, enabled: { "<id>": true }, options: {} }
  patch-state.json     app path, loader path, hashes, app version
  runtime/             installed loader + preload (non-dev installs)
  mods/                installed mods
  data/
    last-played/
      last-played.json
```

## Writing a mod

`mods/<id>/mod.json`:

```json
{
  "id": "my-mod",
  "name": "My Mod",
  "version": "0.1.0",
  "description": "What it does.",
  "main": "main.js",
  "renderer": "renderer.js",
  "platforms": ["darwin"],
  "requiresRestart": true,
  "defaultEnabled": true
}
```

`main.js` exports `activate(ctx)` and optionally `deactivate()`:

```js
module.exports.activate = (ctx) => {
  ctx.log.info('hello from', ctx.id);
  ctx.onPlayerEvent((event) => {
    if (event.type === 'track') ctx.log.info('track', event.track.title);
  });
  ctx.ipc.handle('hello', () => ({ ok: true }));
};
```

`ctx` includes:

- `app`, `ipcMain`, `shell`, `BrowserWindow`, `globalShortcut`, `electron`
- `config.get/all/set` (scoped to the mod id under `config.options`)
- `paths` (`packRoot`, `modsDir`, `configDir`, `dataDir`, `logFile`, `qobuzUserData`)
- `player.currentTrack/playing/position/status`, `player.on(type, fn)`, `player.sendControl(cmd)`
- `onPlayerEvent(fn)` with event types `track`, `progress`, `state`, `clear`, `quit`
- `ipc.handle(method, fn)` for renderer calls via
  `invoke('mod-invoke', '<id>', '<method>', ...args)`
- `ipc.send(channel, ...args)` to push to renderers
- `log.info/warn/error/debug`

Renderer code runs in the preload context with `window.__qobuzModsRenderer`:

```js
const { invoke } = window.__qobuzModsRenderer;
const data = await invoke('mod-invoke', 'last-played', 'list');
```

First-party mods are marked `"bundled": true` and are refreshed on install. User mods are never
overwritten unless `--force` is passed.

## Last played

Investigation result: Qobuz exposes `SORT_BY_RECENTLY_PLAYED` only as an unused enum; the
library sort map has no last-played key, and the local SQLite DB has no play-history table
(`player-0.json` only stores the current queue history). The current implementation records
album starts locally:

```json
{
  "albumId": "xne8h1xxlpfbc",
  "albumTitle": "Big Ideas",
  "artist": "Remi Wolf",
  "artworkUrl": "file:///.../small_cover.png",
  "playCount": 1,
  "lastPlayedAt": 1795106722975,
  "lastTrackTitle": "Wave"
}
```

The menu's **Last played** tab lists albums by most recent play. A library-grid sort can be
added later; the data model is ready.

A server-side last-played sort may exist (`favorite/getUserFavorites` spreads extra query
params), but confirming it requires a read-only authenticated API probe with the user's session.
That has **not** been done. Ask before running it.

## Signing / Gatekeeper

Modifying `main-darwin.js` invalidates the app signature. The patcher extracts the stock app's
entitlements and re-signs the copy ad-hoc with hardened runtime:

```sh
codesign --force --deep --options runtime --entitlements <stock> --sign - "<app>"
```

If macOS quarantines the copy, run:

```sh
xattr -dr com.apple.quarantine "<app>"
```

The patched app's Squirrel auto-updater cannot install updates because the copy is ad-hoc
signed. Update manually:

1. quit the patched app;
2. launch/update the stock Qobuz app;
3. quit it;
4. run `node bin/qobuz-mod.js update`.

## Restore / uninstall

```sh
node bin/qobuz-mod.js restore --app "$HOME/Applications/Qobuz Mod.app"
```

This copies `main-darwin.js.qobuzmod-backup` back, removes `patch-state.json`, and re-signs.
Config, logs, and mods under `QobuzMods/` are kept. Delete that directory to remove user data.

## macOS Now Playing verification

The native addon loads and `setTrack`/`setProgress` are called with the correct metadata
(`Wave / Remi Wolf / Big Ideas / 229s` from the scratch run). System Now Playing verification
is pending because another app (a browser playing SomaFM) currently owns `MPNowPlayingInfoCenter`
on this machine. Once Qobuz is the active player, it should appear in Control Center and in the
Übersicht widget. Play/pause/next/previous use `MPRemoteCommandCenter`; stock media-key
`globalShortcut` registrations are suppressed while the native mod is active.

Seek is not exposed by Qobuz's renderer `media-controls` path, so the replacement has parity
with the old addon (no seek) rather than a regression. It can be added later via
`player-change-offset` plus a native `changePlaybackPosition` command.

## Windows

No Windows support is claimed yet. The CLI already understands `main-win32.js` and
`%APPDATA%\QobuzMods`, and mods can declare `windows` in `platforms`. The next steps are
documented in [`docs/WINDOWS.md`](docs/WINDOWS.md): port the qobuz-smtc native WinRT addon,
hook the same runtime player bridge, and test against Qobuz 8.3.0 / Electron 32.3.3.

## Tests

```sh
node test/loader-smoke.js
```

The smoke test uses a fake Electron main process, a temporary config dir, and the real loader:
it checks preload installation, renderer sources, track/progress events, last-played recording,
deduplication, mod toggling, doctor output, and log writes. It never launches Qobuz or reads the
real Qobuz profile.
