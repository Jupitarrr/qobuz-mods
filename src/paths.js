'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function home() {
  return os.homedir();
}

function configDir(platform = process.platform) {
  if (process.env.QOBUZ_MODS_CONFIG_DIR) {
    return path.resolve(process.env.QOBUZ_MODS_CONFIG_DIR);
  }
  switch (platform) {
    case 'darwin':
      return path.join(home(), 'Library', 'Application Support', 'QobuzMods');
    case 'win32':
      return path.join(
        process.env.APPDATA || path.join(home(), 'AppData', 'Roaming'),
        'QobuzMods',
      );
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(home(), '.config'),
        'QobuzMods',
      );
  }
}

function logFile(platform = process.platform) {
  if (process.env.QOBUZ_MODS_LOG) {
    return path.resolve(process.env.QOBUZ_MODS_LOG);
  }
  switch (platform) {
    case 'darwin':
      return path.join(home(), 'Library', 'Logs', 'qobuz-mods.log');
    case 'win32':
      return path.join(
        process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local'),
        'QobuzMods',
        'logs',
        'qobuz-mods.log',
      );
    default:
      return path.join(
        process.env.XDG_STATE_HOME || path.join(home(), '.local', 'state'),
        'qobuz-mods',
        'qobuz-mods.log',
      );
  }
}

function defaultSourceApp(platform = process.platform) {
  switch (platform) {
    case 'darwin':
      return '/Applications/Qobuz.app';
    case 'win32':
      return path.join(
        process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local'),
        'Programs',
        'Qobuz',
        'Qobuz.exe',
      );
    default:
      return '/opt/Qobuz/qobuz';
  }
}

function defaultTargetApp(platform = process.platform) {
  // In-place patching is the default. Use --app to target a copy.
  return defaultSourceApp(platform);
}

function resourcesAppDir(appPath, platform = process.platform) {
  if (platform === 'darwin') {
    return path.join(appPath, 'Contents', 'Resources', 'app');
  }
  return path.join(appPath, 'resources', 'app');
}

function mainFileName(platform = process.platform) {
  switch (platform) {
    case 'darwin':
      return 'main-darwin.js';
    case 'win32':
      return 'main-win32.js';
    default:
      return 'main.js';
  }
}

function resolveMainFile(appPath, platform = process.platform) {
  const dir = resourcesAppDir(appPath, platform);
  const candidate = path.join(dir, mainFileName(platform));
  if (fs.existsSync(candidate)) return candidate;

  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.main) {
        const resolved = path.join(dir, pkg.main);
        if (fs.existsSync(resolved)) return resolved;
      }
    } catch {
      // Fall through.
    }
  }
  return candidate;
}

function infoPlistPath(appPath) {
  return path.join(appPath, 'Contents', 'Info.plist');
}

function readPackageJson(appPath, platform = process.platform) {
  const pkgPath = path.join(resourcesAppDir(appPath, platform), 'package.json');
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
}

function readPlistValue(plistPath, key) {
  try {
    return execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', `Print :${key}`, plistPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return null;
  }
}

function setPlistValue(plistPath, key, value, type = 'string') {
  execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', `Set :${key} ${value}`, plistPath],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function executableName(appPath) {
  const plist = infoPlistPath(appPath);
  return readPlistValue(plist, 'CFBundleExecutable') || 'Qobuz';
}

function processMatches(pattern) {
  try {
    const out = execFileSync('pgrep', ['-f', pattern], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function isAppRunning(appPath, platform = process.platform) {
  if (platform === 'darwin') {
    const exe = path.join(appPath, 'Contents', 'MacOS', executableName(appPath));
    return processMatches(exe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  if (platform === 'win32') {
    const base = path.basename(appPath, path.extname(appPath));
    return processMatches(`${base}\\.exe`);
  }
  return processMatches(path.basename(appPath));
}

function stockAppRunning() {
  return processMatches('/Applications/Qobuz\\.app/Contents/MacOS/Qobuz');
}

function electronVersion(appPath, platform = process.platform) {
  if (platform !== 'darwin') return null;
  const candidates = [
    path.join(
      appPath,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Resources',
      'Info.plist',
    ),
    path.join(
      appPath,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Resources',
      'Info.plist',
    ),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const value =
      readPlistValue(candidate, 'CFBundleShortVersionString') ||
      readPlistValue(candidate, 'CFBundleVersion');
    if (value) return value;
  }
  return null;
}

module.exports = {
  home,
  configDir,
  logFile,
  defaultSourceApp,
  defaultTargetApp,
  resourcesAppDir,
  mainFileName,
  resolveMainFile,
  infoPlistPath,
  readPackageJson,
  readPlistValue,
  setPlistValue,
  executableName,
  isAppRunning,
  stockAppRunning,
  electronVersion,
  processMatches,
};
