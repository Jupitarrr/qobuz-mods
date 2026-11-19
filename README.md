# Qobuz Mods

A Spicetify-style modding framework for **Qobuz Desktop**. Mods live outside the app
bundle, the patcher injects a single loader line into Qobuz's writable main JS file, and a
**Mods** item in Qobuz's user menu opens a panel to enable/disable them.

Status: **macOS first iteration working.** The installed `/Applications/Qobuz.app` can be
modded and unmodded in place, the user-menu item appears, and Now Playing publishes to macOS
Control Center / the system Now Playing API. Windows scaffolding exists, but Windows is **not
claimed as supported** until tested.

## What works today

- **In-place patcher**: backs up the main JS, injects one require line, and leaves the app's
  original code signature intact. `./uninstall.sh` restores the original file.
- Runtime loader with config, logging, per-mod error isolation, dependency ordering, and a
  narrow IPC bridge.
- In-app **Mods** panel: opened from a **Mods** item between Settings and Log out in the
  user menu. Lists mods, enables/disables them, shows restart-required state, and provides
  open mods folder, view log, and restart Qobuz.
- **Now Playing** (macOS): track metadata, artwork, duration, elapsed time, play/pause state,
  and next/previous/toggle from Control Center / media keys. Uses the existing
  `MPNowPlayingInfoCenter` / `MPRemoteCommandCenter` N-API addon.
- `doctor`, `patch`, `restore`, `update`, `list`, and `build-native` commands.
- Headless loader smoke test (`npm run test:smoke`).

## Why there is no Last Played mod

The requested “last played albums” feature was investigated against the live account and the
official Qobuz API v1.17 documentation:

- `favorite/getUserFavorites` has no `sort` parameter. Extra `sort`/`order` values are ignored:
  every candidate returned the same album order.
- Album items only expose `favorited_at` (library-add date), not a last-played timestamp.
- There is no play-history read endpoint in the official API. Candidate paths such as
  `user/getLastPlayed`, `playhistory/get`, and `track/getLastPlayed` return 400/503.
- `discover/index` containers contain new/recent releases and editorial sections, not the
  user's recently played albums.
- Qobuz's “Playing History” is the local play-queue history (persisted in `player-0.json`),
  and the mobile app's “Recently played” is device/session-local.

Because the feature cannot be sourced from the account, the Last Played mod was removed rather
than maintaining a separate local log. It can return if Qobuz exposes an account-level history
endpoint.

## Quick start (one-line install)

Requires macOS, Node 18+, and Xcode Command Line Tools (for the Now Playing addon). Quit
Qobuz, then paste:

```sh
curl -fsSL https://raw.githubusercontent.com/Jupitarrr/qobuz-mods/main/install.sh | bash
open "/Applications/Qobuz.app"
```

That command downloads the latest source to `~/.qobuz-mods/`, builds the native Now Playing
addon, installs `runtime/` and first-party mods into
`~/Library/Application Support/QobuzMods/`, and patches `/Applications/Qobuz.app` in place.

Pass CLI flags after `--`, for example:

```sh
# Skip the native addon if you do not have Xcode Command Line Tools
curl -fsSL https://raw.githubusercontent.com/Jupitarrr/qobuz-mods/main/install.sh | bash -s -- --no-native

# Overwrite bundled/user mods and allow edge-case patches
curl -fsSL https://raw.githubusercontent.com/Jupitarrr/qobuz-mods/main/install.sh | bash -s -- --force

# Patch a copy instead of the installed app
curl -fsSL https://raw.githubusercontent.com/Jupitarrr/qobuz-mods/main/install.sh | bash -s -- --app "$HOME/Applications/Qobuz Mod.app"
```

To update or re-patch after a Qobuz update, rerun the same one-liner. It refreshes
`~/.qobuz-mods/` from `main` and re-applies the patch. Pin a tag or commit with
`QOBUZ_MODS_REF=v0.1.0`, and override the source directory with `QOBUZ_MODS_HOME`.

The patched app keeps its original Developer ID signature. Only a resource inside the bundle
changes; macOS does not re-check the bundle seal when launching a non-quarantined app, so no
re-signing is needed. See [Signing / Gatekeeper](#signing--gatekeeper).

### From a checkout

```sh
cd ~/off-work/qobuz-mods
./install.sh
open "/Applications/Qobuz.app"
```

Use a checkout when developing mods (see [Development](#development-scratch-copy)).

### Uninstall / restore

```sh
curl -fsSL https://raw.githubusercontent.com/Jupitarrr/qobuz-mods/main/uninstall.sh | bash
```

Or, if you installed from a checkout:

```sh
./uninstall.sh
```

This restores `main-darwin.js` from the backup (and removes the backup file). Config, logs,
and mods under `QobuzMods/` are kept, as is the `~/.qobuz-mods/` source install; delete those
directories to remove user data and the downloaded source.

If `/Applications/Qobuz.app` is not writable by your user, the CLI tells you the exact
`sudo chown` command. It never runs sudo for you.

## Development (scratch copy)

```sh
cd ~/off-work/qobuz-mods
./scripts/build-native.sh
node bin/qobuz-mod.js patch --dev --app ".scratch/Qobuz Dev.app"
open ".scratch/Qobuz Dev.app"
```

`--dev` injects the repo's `runtime/loader.js` and loads mods from the repo, so edits to the
loader/mods only need an app restart, not a re-patch. Config and data still live in
`~/Library/Application Support/QobuzMods/`.

The dev copy gets a distinct bundle id (`com.qobuz.desktop.devmod`) and display name so it can
coexist in LaunchServices with the stock app. It still shares the Qobuz profile and Electron
singleton lock, so quit the stock app first.

## CLI

```sh
qobuz-mod patch [--app PATH] [--source PATH] [--dev] [--refresh] [--force]
qobuz-mod restore [--app PATH]
qobuz-mod update [--app PATH]
qobuz-mod doctor [--app PATH] [--json]
qobuz-mod list [--json]
qobuz-mod build-native
```

- `patch` defaults to `/Applications/Qobuz.app` **in place**.
- `--app` selects another app; if it does not exist, a copy of `--source` is created.
- `--refresh` re-copies a non-in-place target from the source, then patches.
- `--dev` uses the repo runtime/mods and requires a scratch `--app` path.
- `--force` allows edge-case patches and overwrites bundled/user mods on install.
- `--sign` re-signs the app ad-hoc after patching (not recommended; see below);
  `--no-native` skips the addon build.

`doctor` reports app/Electron versions, paths, injection and backup state, signature status,
config, mods, running processes, and recent log errors.

## How it works

### One-line injection

The patcher backs up the original `main-darwin.js` to
`main-darwin.js.qobuzmod-backup` and prepends:

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

The menu is a core mod (`mods/mods-menu/renderer.js`) and cannot be disabled. It inserts
its **Mods** item directly into Qobuz's own `.NavBarMenu__items` list (after Settings and
before Log out), so no extra app-bundle patch is needed. A `MutationObserver` re-inserts the
item if React remounts the user menu.

## Layout

```
bin/qobuz-mod.js            CLI: patch / restore / update / doctor / list / build-native
src/patcher/                paths, backup, injection, plist, signature checks, runtime install
runtime/loader.js           injected main-process loader + player bridge + IPC
runtime/renderer.js         renderer preload (bridge + renderer mod eval)
mods/now-playing/           macOS MPNowPlayingInfoCenter addon + main mod
mods/mods-menu/             core user-menu item + mods panel
scripts/build-native.sh     builds the macOS N-API addon
test/loader-smoke.js        headless fake-Electron loader test
install.sh / uninstall.sh   local or curl-based bootstrap, patch/unpatch
```

## Paths

| What | Where |
| --- | --- |
| Config / mods (macOS) | `~/Library/Application Support/QobuzMods/` |
| Config / mods (Windows) | `%APPDATA%\QobuzMods\` |
| Log (macOS) | `~/Library/Logs/qobuz-mods.log` |
| Log (Windows) | `%LOCALAPPDATA%\QobuzMods\logs\qobuz-mods.log` |
| Downloaded source (curl installs) | `~/.qobuz-mods/` |

```
QobuzMods/
  config.json          { version, enabled: { "<id>": true }, options: {} }
  patch-state.json     app path, loader path, hashes, app version
  runtime/             installed loader + preload (non-dev installs)
  mods/                installed mods
  data/<mod-id>/       per-mod persistent data
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
const result = await invoke('mod-invoke', 'my-mod', 'hello');
```

First-party mods are marked `"bundled": true` and are refreshed on install. User mods are never
overwritten unless `--force` is passed. Retired first-party mods are removed on install.

## Signing / Gatekeeper

Patching only touches resources: it rewrites `Contents/Resources/app/main-darwin.js` and drops
`main-darwin.js.qobuzmod-backup` next to it. The Mach-O executable, frameworks, and helper apps
are untouched. `codesign --verify` therefore reports a modified sealed resource, but macOS does
**not** re-validate the bundle seal when launching a non-quarantined app. The patched app starts
normally with its **original Developer ID signature** and everything that depends on it:

- the Developer ID designated requirement (`anchor apple generic …`), which is what Squirrel
  derives its update validator from — instead of an ad-hoc `cdhash H"…"` requirement;
- the notarization ticket and the CDHash, so Gatekeeper approval caches, LaunchServices, and
  TCC/Privacy grants keyed to the app identity still match;
- untouched framework/helper signatures.

So the patcher does **not** re-sign by default. `--sign` restores the old behaviour (extract
entitlements and `codesign --force --deep --options runtime --sign -`). It is only useful if a
future Qobuz build starts validating its own signature at launch. Ad-hoc signing replaces the
Developer ID identity with a local cdhash, invalidates the notarization ticket, and does not
satisfy Gatekeeper either.

`doctor` reflects this: it verifies the **executable's** signature (`codesign --verify
--ignore-resources`) and reports the bundle seal as “modified by the loader injection
(expected)”. Note that you need `--sign` (or a reinstall of Qobuz) to recover a seal that was
broken by an older, ad-hoc-signed patch.

The one thing that matters is quarantine. A quarantined app with a modified seal is blocked by
Gatekeeper, and ad-hoc signing does not change that. The patcher strips
`com.apple.quarantine` before patching (and when copying an app); if you still see the warning,
run:

```sh
xattr -dr com.apple.quarantine "/Applications/Qobuz.app"
```

### Updates

Squirrel compares the downloaded update against the requirement of the running app. With the
original signature left in place that requirement is still Qobuz's Developer ID, so auto-update
has the best chance of working (it replaces the patched JS; re-apply the patch afterwards).
With `--sign` the app's requirement is a cdhash, and Squirrel will reject genuine updates.

Auto-update is not guaranteed in either mode. The supported flow is:

1. quit Qobuz;
2. run the uninstall one-liner (or `./uninstall.sh` from a checkout) to restore the original
   main JS;
3. launch Qobuz and let it update (or reinstall Qobuz from the DMG);
4. quit Qobuz;
5. rerun the install one-liner (or `./install.sh`).

`node bin/qobuz-mod.js update` re-applies the patch and rebuilds the native addon; the
patcher detects a changed stock main file and refreshes its backup.

## macOS Now Playing

The native addon loads and `setTrack`/`setProgress` are called with the correct metadata
(`Wave / Remi Wolf / Big Ideas / 229s` from the scratch run). Play/pause/next/previous use
`MPRemoteCommandCenter`; stock media-key `globalShortcut` registrations are suppressed while
the native mod is active.

Seek is not exposed by Qobuz's renderer `media-controls` path, so the replacement has parity
with the old addon (no seek) rather than a regression. It can be added later via
`player-change-offset` plus a native `changePlaybackPosition` command.

## Windows

No Windows support is claimed yet. The CLI already understands `main-win32.js` and
`%APPDATA%\QobuzMods`, and mods can declare `windows` in `platforms`. The next steps are
to port the qobuz-smtc native WinRT addon, hook the same runtime player bridge, and test
against Qobuz 8.3.0 / Electron 32.3.3.

## Tests

```sh
npm run test:smoke
npm run test:installer
```

The loader smoke test uses a fake Electron main process, a temporary config dir, and the real
loader: it checks preload installation, renderer sources, track/progress events, mod listing,
mod toggling, doctor output, and log writes. It never launches Qobuz or reads the real Qobuz
profile.

The installer smoke test builds a local source tarball, runs `install.sh` through stdin (the
same path as `curl ... | bash`), and verifies it extracts to a temporary `QOBUZ_MODS_HOME`
and runs the CLI. It does not patch Qobuz.
