#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const paths = require('../src/paths');
const {
  ensureDir,
  readJSON,
  runInherit,
  expandHome,
  tailFile,
  formatBytes,
  fileSha256,
} = require('../src/util');
const patcher = require('../src/patcher');
const {
  ensureDefaultConfig,
  installRuntime,
} = require('../src/patcher/install-runtime');

const REPO_ROOT = path.resolve(__dirname, '..');
const VERSION = require('../package.json').version;
const PLATFORM = process.platform;

const OPTIONS = {
  app: { type: 'string', short: 'a' },
  source: { type: 'string', short: 's' },
  dev: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  refresh: { type: 'boolean', default: false },
  'bundle-id': { type: 'string' },
  'no-sign': { type: 'boolean', default: false },
  'no-native': { type: 'boolean', default: false },
  'build-native': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const COLOR =
  process.stdout.isTTY && !process.env.NO_COLOR
    ? {
        reset: '\x1b[0m',
        bold: '\x1b[1m',
        dim: '\x1b[2m',
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        blue: '\x1b[34m',
      }
    : Object.fromEntries(
        ['reset', 'bold', 'dim', 'red', 'green', 'yellow', 'blue'].map((k) => [k, '']),
      );

function paint(color, text) {
  return `${COLOR[color]}${text}${COLOR.reset}`;
}

function fail(message) {
  // eslint-disable-next-line no-console
  console.error(`${paint('red', 'error:')} ${message}`);
  process.exit(1);
}

function warn(message) {
  // eslint-disable-next-line no-console
  console.warn(`${paint('yellow', 'warning:')} ${message}`);
}

function info(message) {
  // eslint-disable-next-line no-console
  console.log(message);
}

function check(ok, label, detail = '') {
  const mark = ok ? paint('green', '✓') : paint('red', '✗');
  info(`  ${mark} ${label}${detail ? ` ${paint('dim', detail)}` : ''}`);
}

function header(text) {
  info(`\n${paint('bold', text)}`);
}

function resolveApp(opts) {
  const source = path.resolve(expandHome(opts.source || paths.defaultSourceApp(PLATFORM)));
  // Default to patching the installed app in place. --app selects a copy.
  const app = path.resolve(expandHome(opts.app || source));
  return { source, app };
}

function appInfo(appPath) {
  if (!fs.existsSync(appPath)) return null;
  const pkg = paths.readPackageJson(appPath, PLATFORM);
  if (!pkg) return null;
  const main = paths.resolveMainFile(appPath, PLATFORM);
  let bundleId = null;
  let displayName = null;
  if (PLATFORM === 'darwin') {
    const plist = paths.infoPlistPath(appPath);
    bundleId = paths.readPlistValue(plist, 'CFBundleIdentifier');
    displayName = paths.readPlistValue(plist, 'CFBundleDisplayName');
  }
  return {
    path: appPath,
    version: pkg.version || null,
    uiVersion:
      (pkg.dependencies && pkg.dependencies['@qobuz/qobuz-dwp-ui']) || null,
    main,
    mainExists: fs.existsSync(main),
    electron: paths.electronVersion(appPath, PLATFORM),
    bundleId,
    displayName,
  };
}

function validateQobuzApp(appPath, label) {
  const info = appInfo(appPath);
  if (!info) {
    fail(`${label} does not look like a Qobuz app (missing app/package.json): ${appPath}`);
  }
  if (!info.mainExists) {
    fail(`${label} is missing its main file: ${info.main}`);
  }
  return info;
}

function ensureNotRunning(appPath) {
  if (paths.isAppRunning(appPath, PLATFORM)) {
    fail(
      `app is running: ${appPath}\n` +
        'Quit it first. qobuz-mod never kills or relaunches a running Qobuz.',
    );
  }
}

function ensureWritable(appPath) {
  if (PLATFORM !== 'darwin') return;
  const main = paths.resolveMainFile(appPath, PLATFORM);
  try {
    fs.accessSync(main, fs.constants.W_OK);
    fs.accessSync(path.dirname(main), fs.constants.W_OK);
    fs.accessSync(appPath, fs.constants.W_OK);
  } catch {
    fail(
      `app is not writable: ${appPath}\n` +
        `Fix with: sudo chown -R "$(whoami)" "${appPath}"`,
    );
  }
}

function copyApp(source, target, opts) {
  if (PLATFORM !== 'darwin') {
    fail('copying an app bundle is currently implemented for macOS only');
  }
  if (target === source) fail('source and target are the same path');

  ensureDir(path.dirname(target));
  if (fs.existsSync(target)) {
    ensureNotRunning(target);
    fs.rmSync(target, { recursive: true, force: true });
  }

  info(`copying ${source} -> ${target}`);
  runInherit('ditto', [source, target]);
  patcher.stripQuarantine(target);

  const bundleId =
    opts['bundle-id'] ||
    (opts.dev ? 'com.qobuz.desktop.devmod' : 'com.qobuz.desktop.mod');
  const displayName = opts.dev ? 'Qobuz Dev' : 'Qobuz Mod';
  const plist = paths.infoPlistPath(target);
  // Keep CFBundleName/CFBundleExecutable as "Qobuz": Electron derives helper
  // names and the shared user-data directory from them.
  patcher.setPlistString(plist, 'CFBundleIdentifier', bundleId);
  patcher.setPlistString(plist, 'CFBundleDisplayName', displayName);
  info(`set bundle id ${paint('dim', bundleId)}, display name ${paint('dim', displayName)}`);
}

function ensureNativeAddon(opts) {
  if (opts['no-native']) {
    info('skipping native addon build (--no-native)');
    return null;
  }

  const target = path.join(REPO_ROOT, 'mods', 'now-playing', 'qobuz-nowplaying.node');
  if (fs.existsSync(target) && !opts['build-native']) {
    info(`native addon present: ${target}`);
    return target;
  }

  if (PLATFORM !== 'darwin') {
    warn('now-playing is not implemented for this platform yet; skipping native build');
    return null;
  }

  info('building native Now Playing addon...');
  try {
    runInherit('bash', [path.join(REPO_ROOT, 'scripts', 'build-native.sh')], {
      cwd: REPO_ROOT,
    });
    return target;
  } catch (error) {
    warn(
      `native addon build failed (${error.message}). The rest of the framework will ` +
        'still be installed; the Now Playing mod will report the missing addon.',
    );
    return null;
  }
}

function modsDirFor(loaderPath) {
  if (loaderPath) {
    const candidate = path.resolve(path.dirname(loaderPath), '..', 'mods');
    if (fs.existsSync(candidate)) return candidate;
  }
  const installed = path.join(paths.configDir(PLATFORM), 'mods');
  if (fs.existsSync(installed)) return installed;
  return path.join(REPO_ROOT, 'mods');
}

function scanMods(modsDir, config) {
  if (!fs.existsSync(modsDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(modsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(modsDir, entry.name);
    const manifestPath = path.join(dir, 'mod.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = readJSON(manifestPath, null);
    if (!manifest) {
      out.push({
        id: entry.name,
        name: entry.name,
        error: 'invalid mod.json',
        enabled: false,
      });
      continue;
    }
    const id = String(manifest.id || entry.name);
    const core = Boolean(manifest.core);
    const enabled = core ? true : config.enabled[id] !== false;
    out.push({
      id,
      name: String(manifest.name || id),
      version: String(manifest.version || '0.0.0'),
      description: String(manifest.description || ''),
      core,
      platforms: Array.isArray(manifest.platforms) ? manifest.platforms : null,
      main: manifest.main ? path.join(dir, String(manifest.main)) : null,
      renderer: manifest.renderer ? path.join(dir, String(manifest.renderer)) : null,
      enabled,
      error: null,
    });
  }
  return out.sort((a, b) => {
    if (a.core !== b.core) return a.core ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });
}

function findLoaderPath(injectionLine) {
  if (!injectionLine) return null;
  const match = injectionLine.match(/;require\((["'])(.+?)\1\)/);
  return match ? match[2] : null;
}

function signEverything({ app, source, opts, addonPath, entitlements = null }) {
  if (opts['no-sign'] || PLATFORM !== 'darwin') {
    info('skipping codesign (--no-sign or non-macOS)');
    return { signed: false, verified: null };
  }

  if (!entitlements) {
    try {
      entitlements = patcher.extractEntitlements(source);
    } catch {
      warn('could not extract entitlements from the source app; signing without them');
    }
  }

  if (addonPath && fs.existsSync(addonPath)) {
    info(`signing native addon ${paint('dim', addonPath)}`);
    patcher.signAddon(addonPath);
  }

  info('signing app (ad-hoc, hardened runtime)...');
  patcher.signApp(app, entitlements);

  const verified = patcher.verifyApp(app);
  if (!verified.ok) {
    fail(`codesign verification failed: ${verified.output}`);
  }

  patcher.registerWithLaunchServices(app);
  return { signed: true, verified: verified.ok, entitlements };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function commandPatch(opts) {
  const { source, app } = resolveApp(opts);
  const inPlace = app === source;

  const sourceInfo = validateQobuzApp(source, 'source app');
  info(
    `source: ${paint('bold', source)}\n` +
      `        Qobuz ${sourceInfo.version}, Electron ${sourceInfo.electron || '?'}`,
  );

  if (opts.dev && inPlace) {
    fail(
      '--dev patches a scratch copy, not the installed app. Pass ' +
        '--app ".scratch/Qobuz Dev.app" so the repo loader/mods are used.',
    );
  }
  if (inPlace && opts['bundle-id']) {
    warn('--bundle-id only applies to copied apps; ignoring it for the in-place patch');
  }

  const targetExisted = fs.existsSync(app);
  if (!targetExisted) {
    if (inPlace) fail(`app not found: ${app}`);
    copyApp(source, app, opts);
  } else if (opts.refresh && !inPlace) {
    copyApp(source, app, opts);
  } else {
    validateQobuzApp(app, 'target app');
    info(`target: ${paint('bold', app)} ${inPlace ? '(in place)' : '(existing)'}`);
  }

  ensureNotRunning(app);
  ensureWritable(app);

  if (!inPlace && paths.stockAppRunning()) {
    warn(
      'stock /Applications/Qobuz.app is running. The patched app shares its profile ' +
        'and Electron singleton, so quit the stock app before launching the patched app.',
    );
  }
  if (opts.dev && app.includes('/Applications/Qobuz Mod.app')) {
    warn('--dev targets a path that looks like the working Qobuz Mod.app; use .scratch instead');
  }

  // Extract entitlements before touching the app, while the original signature
  // is still intact.
  let entitlements = null;
  if (PLATFORM === 'darwin') {
    try {
      entitlements = patcher.extractEntitlements(source);
    } catch {
      warn('could not extract entitlements from the source app; signing without them');
    }
  }

  const addonPath = ensureNativeAddon(opts);

  const configDir = paths.configDir(PLATFORM);
  let runtime;
  if (opts.dev) {
    ensureDefaultConfig(configDir);
    runtime = {
      runtimeDir: path.join(REPO_ROOT, 'runtime'),
      modsDir: path.join(REPO_ROOT, 'mods'),
      configFile: path.join(configDir, 'config.json'),
      source: 'repo (dev)',
    };
  } else {
    runtime = installRuntime({
      repoRoot: REPO_ROOT,
      configDir,
      force: opts.force,
    });
    runtime.source = 'installed';
  }

  info(
    `runtime: ${paint('dim', runtime.runtimeDir)} (${runtime.source})\n` +
      `mods:    ${paint('dim', runtime.modsDir)}`,
  );

  const loaderPath = opts.dev
    ? path.join(REPO_ROOT, 'runtime', 'loader.js')
    : path.join(configDir, 'runtime', 'loader.js');

  const result = patcher.applyPatch({
    appPath: app,
    loaderPath,
    configDir,
    platform: PLATFORM,
    force: opts.force,
  });

  if (result.note) info(`patch: ${result.note}`);

  const signing = signEverything({ app, source, opts, addonPath, entitlements });

  if (opts.json) {
    info(
      JSON.stringify(
        {
          ok: true,
          version: VERSION,
          source,
          app,
          inPlace,
          loaderPath,
          configDir,
          modsDir: runtime.modsDir,
          patch: result,
          signing,
        },
        null,
        2,
      ),
    );
    return;
  }

  header('Patched');
  check(true, 'main file', result.mainFile);
  check(true, 'injection', result.injectionLine);
  check(fs.existsSync(result.backupFile), 'backup', result.backupFile);
  check(Boolean(signing.verified), 'codesign', signing.signed ? 'ad-hoc' : 'skipped');
  info(`\n${paint('green', 'Done.')} Launch with: ${paint('bold', `open "${app}"`)}`);
  info(`Logs: ${paths.logFile(PLATFORM)}`);
  info(
    `Mods: ${runtime.modsDir}\n` +
      `Config: ${runtime.configFile}\n` +
      'Quit Qobuz before launching the patched app.',
  );
}

function commandRestore(opts) {
  const { source, app } = resolveApp(opts);
  validateQobuzApp(app, 'target app');
  ensureNotRunning(app);
  ensureWritable(app);

  // Extract entitlements before restoring, while the signature is intact.
  let entitlements = null;
  if (PLATFORM === 'darwin') {
    try {
      entitlements = patcher.extractEntitlements(source);
    } catch {
      warn('could not extract entitlements from the source app; signing without them');
    }
  }

  const result = patcher.restorePatch({
    appPath: app,
    configDir: paths.configDir(PLATFORM),
    platform: PLATFORM,
  });

  if (!result.restoredFrom) {
    info('no injection or backup found; nothing to restore');
    return;
  }

  info(`restored main file from ${result.restoredFrom}`);
  signEverything({ app, source, opts, addonPath: null, entitlements });

  if (opts.json) {
    info(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }

  header('Restored');
  check(true, 'main file', result.mainFile);
  check(true, 'source', result.restoredFrom);
}

function commandDoctor(opts) {
  const { source, app } = resolveApp(opts);
  const inPlace = app === source;
  const configDir = paths.configDir(PLATFORM);
  const configFile = path.join(configDir, 'config.json');
  const config = readJSON(configFile, { version: 1, enabled: {}, options: {} });

  const sourceInfo = fs.existsSync(source) ? appInfo(source) : null;
  const targetInfo = fs.existsSync(app) ? appInfo(app) : null;
  const inspection = targetInfo
    ? patcher.inspectPatch({ appPath: app, configDir, platform: PLATFORM })
    : null;

  const loaderPath = inspection ? findLoaderPath(inspection.injectionLine) : null;
  const modsDir = modsDirFor(loaderPath);
  const mods = scanMods(modsDir, config);
  const modsWithErrors = mods.filter((mod) => mod.error);

  const addonCandidates = [
    path.join(modsDir, 'now-playing', 'qobuz-nowplaying.node'),
    path.join(configDir, 'mods', 'now-playing', 'qobuz-nowplaying.node'),
    path.join(REPO_ROOT, 'mods', 'now-playing', 'qobuz-nowplaying.node'),
  ];
  const addon =
    [...new Set(addonCandidates)].find((candidate) => fs.existsSync(candidate)) || null;

  const signature = targetInfo ? patcher.signatureInfo(app) : null;
  const verification = targetInfo ? patcher.verifyApp(app) : null;
  const logLines = tailFile(paths.logFile(PLATFORM), 30);
  const logErrors = logLines
    .split('\n')
    .filter((line) => line.includes('[error]'))
    .slice(-8);

  const warnings = [];
  if (!targetInfo) warnings.push(`target app does not exist: ${app}`);
  if (paths.stockAppRunning()) {
    warnings.push(
      inPlace
        ? 'Qobuz is running; quit it before patching or restoring'
        : 'stock /Applications/Qobuz.app is running; quit it before launching the patched app',
    );
  }
  if (!inPlace && targetInfo && paths.isAppRunning(app)) {
    warnings.push('the patched app is currently running');
  }
  if (inspection && !inspection.injected) warnings.push('target main file is not injected');
  if (inspection && inspection.injected && !inspection.backupExists) {
    warnings.push('injected but no backup exists; restore will not be possible');
  }
  if (inspection && inspection.backupExists && inspection.backupMatches === false) {
    warnings.push('backup does not match the current stock base (app may have updated)');
  }
  if (!addon) warnings.push('now-playing native addon is not built');
  if (inspection && inspection.legacyBootstrap) {
    warnings.push('target contains the legacy qobuz-mod-bootstrap.js patch');
  }
  if (modsWithErrors.length > 0) warnings.push('some mod manifests could not be read');

  const report = {
    tool: { version: VERSION, platform: PLATFORM, node: process.version },
    source,
    app,
    inPlace,
    sourceInfo,
    targetInfo,
    inspection,
    loaderPath,
    modsDir,
    configDir,
    configFile,
    config,
    mods,
    addon,
    signature,
    verification,
    running: {
      stock: paths.stockAppRunning(),
      target: targetInfo ? paths.isAppRunning(app) : false,
    },
    logFile: paths.logFile(PLATFORM),
    logErrors,
    warnings,
  };

  if (opts.json) {
    info(JSON.stringify(report, null, 2));
    return;
  }

  info(`${paint('bold', 'Qobuz Mods doctor')} ${paint('dim', `v${VERSION}`)}`);
  info(`platform: ${PLATFORM}   node: ${process.version}`);

  header('Apps');
  if (inPlace) {
    if (targetInfo) {
      check(
        true,
        'app (in place)',
        `${app}  Qobuz ${targetInfo.version}  Electron ${targetInfo.electron || '?'}  bundle=${targetInfo.bundleId || '?'}`,
      );
    } else {
      check(false, 'app', `${app} (missing)`);
    }
  } else {
    if (sourceInfo) {
      check(true, 'stock app', `${source}  Qobuz ${sourceInfo.version}  Electron ${sourceInfo.electron || '?'}`);
    } else {
      check(false, 'stock app', source);
    }
    if (targetInfo) {
      check(
        true,
        'target app',
        `${app}  Qobuz ${targetInfo.version}  bundle=${targetInfo.bundleId || '?'}`,
      );
    } else {
      check(false, 'target app', `${app} (missing)`);
    }
  }

  header('Patch');
  if (inspection) {
    check(inspection.exists, 'main file', inspection.mainFile);
    check(inspection.injected, 'injected', inspection.injectionLine || '(no)');
    if (inspection.backupExists) {
      let backupSize = 0;
      try {
        backupSize = fs.statSync(inspection.backupFile).size;
      } catch {
        backupSize = 0;
      }
      check(
        inspection.backupMatches !== false,
        'backup',
        `${inspection.backupFile} (${formatBytes(backupSize)})`,
      );
    } else {
      check(false, 'backup', 'missing');
    }
    if (inspection.state) {
      check(
        true,
        'patch state',
        `${inspection.state.appVersion || '?'} ${inspection.state.patchedAt || ''}`,
      );
    }
    if (inspection.legacyBootstrap) {
      check(false, 'legacy bootstrap', 'qobuz-mod-bootstrap.js present');
    }
  } else {
    check(false, 'patch', 'target missing');
  }

  header('Signing');
  if (verification && signature) {
    check(verification.ok, 'codesign verify', verification.ok ? '' : verification.output);
    check(Boolean(signature.signature), 'signature', `${signature.signature || '?'} / ${signature.identifier || '?'}`);
  } else {
    check(false, 'signature', 'not available');
  }

  header('Runtime / mods');
  check(Boolean(loaderPath), 'loader', loaderPath || '(no injection)');
  if (loaderPath) check(fs.existsSync(loaderPath), 'loader exists', loaderPath);
  check(Boolean(addon), 'native addon', addon || 'missing');
  info(`  mods directory: ${modsDir}`);
  if (mods.length === 0) {
    info(`  ${paint('yellow', 'no mods found')}`);
  } else {
    for (const mod of mods) {
      const flags = [
        mod.core ? 'core' : mod.enabled ? 'enabled' : 'disabled',
        mod.platforms ? mod.platforms.join(',') : 'all',
      ];
      const mark = mod.error ? paint('red', '✗') : paint('green', '•');
      info(`  ${mark} ${mod.name}@${mod.version} ${paint('dim', `[${flags.join(' ')}]`)}`);
      if (mod.error) info(`      ${paint('red', mod.error)}`);
    }
  }
  info(`  config: ${configFile}`);
  info(`  ${paint('dim', JSON.stringify(config.enabled || {}))}`);

  header('Processes');
  if (inPlace) {
    check(!report.running.target, 'app running', report.running.target ? 'yes' : 'no');
  } else {
    check(!report.running.stock, 'stock app running', report.running.stock ? 'yes' : 'no');
    check(!report.running.target, 'target app running', report.running.target ? 'yes' : 'no');
  }

  header('Log');
  info(`  ${paths.logFile(PLATFORM)}`);
  if (logErrors.length > 0) {
    for (const line of logErrors) info(`  ${paint('red', line)}`);
  } else {
    info(`  ${paint('dim', 'no recent errors')}`);
  }

  if (warnings.length > 0) {
    header('Warnings');
    for (const message of warnings) info(`  ${paint('yellow', '!')} ${message}`);
  }
}

function commandList(opts) {
  const configDir = paths.configDir(PLATFORM);
  const config = readJSON(path.join(configDir, 'config.json'), {
    version: 1,
    enabled: {},
    options: {},
  });
  const installed = path.join(configDir, 'mods');
  const modsDir = fs.existsSync(installed) ? installed : path.join(REPO_ROOT, 'mods');
  const mods = scanMods(modsDir, config);

  if (opts.json) {
    info(JSON.stringify({ modsDir, mods }, null, 2));
    return;
  }

  info(`${paint('bold', 'Mods')} ${paint('dim', modsDir)}`);
  if (mods.length === 0) {
    info('  (none)');
    return;
  }
  for (const mod of mods) {
    const status = mod.core ? 'core' : mod.enabled ? 'on' : 'off';
    const mark = mod.enabled ? paint('green', '●') : paint('dim', '○');
    info(`  ${mark} ${status.padEnd(4)} ${mod.name}@${mod.version} ${paint('dim', `(${mod.id})`)}`);
    if (mod.description) info(`         ${paint('dim', mod.description)}`);
  }
}

function commandUpdate(opts) {
  const { source, app } = resolveApp(opts);
  const inPlace = app === source;
  info(
    inPlace
      ? 're-applying the in-place patch (backup/version detection will run)...'
      : 'refreshing target from the stock app and re-applying...',
  );
  commandPatch({ ...opts, refresh: !inPlace, force: true, 'build-native': true });
}

function commandBuildNative() {
  runInherit('bash', [path.join(REPO_ROOT, 'scripts', 'build-native.sh')], {
    cwd: REPO_ROOT,
  });
}

function commandHelp() {
  info(`qobuz-mod ${VERSION} — mod framework for Qobuz Desktop

Usage:
  qobuz-mod <command> [options]

Commands:
  patch       Copy the stock app (if needed), install runtime/mods, inject the
              loader, and ad-hoc sign the result.
  restore     Restore the original main file from the patcher backup and re-sign.
  update      Refresh the target from /Applications/Qobuz.app and re-patch.
  doctor      Report app version, paths, injection status, config, mods, signing,
              running processes, and recent log errors.
  list        List installed mods and their enabled state.
  build-native Build the macOS Now Playing N-API addon.
  version     Print the CLI version.
  help        Show this help.

Options:
  -a, --app <path>       App to patch (default: /Applications/Qobuz.app, in place)
  -s, --source <path>    Source app when --app creates a copy (default: /Applications/Qobuz.app)
      --dev              Use the repo's runtime/ and mods/ directly (no copy)
      --refresh          Re-copy the target from the source before patching
      --force            Overwrite bundled mods / allow edge-case patches
      --bundle-id <id>   Bundle id for the copied app
      --no-sign          Skip codesign (not recommended)
      --no-native        Skip building the Now Playing addon
      --build-native     Rebuild the Now Playing addon even if present
      --json             Machine-readable output (doctor/list/patch/restore)
  -h, --help             Show help

Examples:
  # Development against a scratch copy (does not touch the installed app)
  node bin/qobuz-mod.js patch --dev --app ".scratch/Qobuz Dev.app"

  # Inspect the scratch install
  node bin/qobuz-mod.js doctor --app ".scratch/Qobuz Dev.app"

  # User install: mod the installed Qobuz.app in place
  ./install.sh

  # Unmod: restore the original main file and re-sign
  ./uninstall.sh

  # After a Qobuz update
  node bin/qobuz-mod.js update
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  let command = 'help';
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    command = argv.shift();
  }

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    fail(error.message);
  }
  const opts = parsed.values;
  if (opts.help) command = 'help';

  switch (command) {
    case 'patch':
      commandPatch(opts);
      break;
    case 'restore':
      commandRestore(opts);
      break;
    case 'doctor':
      commandDoctor(opts);
      break;
    case 'list':
      commandList(opts);
      break;
    case 'update':
      commandUpdate(opts);
      break;
    case 'build-native':
      commandBuildNative();
      break;
    case 'version':
      info(VERSION);
      break;
    case 'help':
      commandHelp();
      break;
    default:
      fail(`unknown command: ${command}\nRun "qobuz-mod help" for usage.`);
  }
}

try {
  main();
} catch (error) {
  fail(error && error.stack ? error.stack : String(error));
}
