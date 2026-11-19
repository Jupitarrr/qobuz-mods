'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  readJSON,
  writeJSONAtomic,
  sha256,
  ensureDir,
} = require('../util');
const {
  resolveMainFile,
  readPackageJson,
} = require('../paths');

const MARKER = '/*qobuz-mods*/';
const BACKUP_SUFFIX = '.qobuzmod-backup';
const LEGACY_REQUIRE = 'qobuz-mod-bootstrap.js';

function injectionLine(loaderPath) {
  return `;require(${JSON.stringify(loaderPath)});${MARKER}`;
}

function findInjection(text) {
  if (!text) return null;
  const newline = text.indexOf('\n');
  const firstLine = newline === -1 ? text : text.slice(0, newline);
  if (firstLine.includes(MARKER)) return firstLine;
  // Accept a plain loader require from an earlier framework version.
  if (/^;require\(["'][^"']*qobuz[-_]?mods?[^"']*["']\);?/i.test(firstLine)) {
    return firstLine;
  }
  return null;
}

function stripInjection(text) {
  const line = findInjection(text);
  if (!line) return text;
  let rest = text.slice(line.length);
  if (rest.startsWith('\r\n')) rest = rest.slice(2);
  else if (rest.startsWith('\n')) rest = rest.slice(1);
  return rest;
}

function stateFile(configDir) {
  return path.join(configDir, 'patch-state.json');
}

function inspectPatch({ appPath, configDir, platform = process.platform }) {
  const mainFile = resolveMainFile(appPath, platform);
  const exists = fs.existsSync(mainFile);
  const text = exists ? fs.readFileSync(mainFile, 'utf8') : '';
  const backupFile = `${mainFile}${BACKUP_SUFFIX}`;
  const backupExists = fs.existsSync(backupFile);
  const backupText = backupExists ? fs.readFileSync(backupFile, 'utf8') : null;

  return {
    appPath,
    platform,
    mainFile,
    exists,
    size: exists ? Buffer.byteLength(text, 'utf8') : 0,
    sha256: exists ? sha256(Buffer.from(text, 'utf8')) : null,
    injected: Boolean(findInjection(text)),
    injectionLine: findInjection(text),
    backupFile,
    backupExists,
    backupSha256: backupText ? sha256(Buffer.from(backupText, 'utf8')) : null,
    backupMatches: backupExists ? backupText === stripInjection(text) : null,
    state: readJSON(stateFile(configDir), null),
    legacyBootstrap: text.includes(LEGACY_REQUIRE),
  };
}

function applyPatch({
  appPath,
  loaderPath,
  configDir,
  platform = process.platform,
  force = false,
}) {
  const mainFile = resolveMainFile(appPath, platform);
  if (!fs.existsSync(mainFile)) {
    throw new Error(`main file not found: ${mainFile}`);
  }

  ensureDir(configDir);
  const backupFile = `${mainFile}${BACKUP_SUFFIX}`;
  const sFile = stateFile(configDir);
  const appPkg = readPackageJson(appPath, platform);
  const appVersion = appPkg ? appPkg.version || null : null;

  const current = fs.readFileSync(mainFile, 'utf8');
  let base = current;
  let note = null;

  const existingInjection = findInjection(current);

  if (existingInjection) {
    if (!fs.existsSync(backupFile)) {
      throw new Error(
        `main file is already injected but no backup exists (${backupFile}). ` +
          'Refusing to guess the original. Re-copy Qobuz.app, or restore manually.',
      );
    }

    const previousState = readJSON(sFile, null);
    const versionChanged =
      previousState &&
      previousState.appVersion &&
      appVersion &&
      previousState.appVersion !== appVersion;

    if (versionChanged) {
      // Qobuz updated in place while the old injection was present. The current
      // file minus our single line is the new stock base.
      base = stripInjection(current);
      fs.writeFileSync(backupFile, base, 'utf8');
      note = `app version changed (${previousState.appVersion} -> ${appVersion}); refreshed backup`;
    } else {
      base = fs.readFileSync(backupFile, 'utf8');
      note = 'restored original from backup before re-applying';
    }
  } else if (fs.existsSync(backupFile)) {
    const backupText = fs.readFileSync(backupFile, 'utf8');
    if (backupText !== current) {
      // A newer stock file was installed. Refresh the backup.
      fs.writeFileSync(backupFile, current, 'utf8');
      note = 'stock main file changed; refreshed backup';
    }
  } else {
    fs.writeFileSync(backupFile, current, 'utf8');
    note = 'created backup';
  }

  if (base.includes(LEGACY_REQUIRE) && !force) {
    throw new Error(
      'main file contains the legacy qobuz-mod-bootstrap.js patch. ' +
        'Use a fresh copy of Qobuz.app (recommended), or pass --force to inject alongside it.',
    );
  }

  if (findInjection(base)) {
    base = stripInjection(base);
  }

  const line = injectionLine(loaderPath);
  const patched = `${line}\n${base}`;
  fs.writeFileSync(mainFile, patched, 'utf8');

  const result = {
    appPath,
    mainFile,
    backupFile,
    stateFile: sFile,
    loaderPath,
    appVersion,
    platform,
    injectionLine: line,
    originalSha256: sha256(Buffer.from(base, 'utf8')),
    patchedSha256: sha256(Buffer.from(patched, 'utf8')),
    patchedAt: new Date().toISOString(),
    note,
  };

  writeJSONAtomic(sFile, result);
  return result;
}

function restorePatch({ appPath, configDir, platform = process.platform }) {
  const mainFile = resolveMainFile(appPath, platform);
  if (!fs.existsSync(mainFile)) {
    throw new Error(`main file not found: ${mainFile}`);
  }

  const backupFile = `${mainFile}${BACKUP_SUFFIX}`;
  let restoredFrom = null;

  if (fs.existsSync(backupFile)) {
    fs.copyFileSync(backupFile, mainFile);
    restoredFrom = backupFile;
    // Remove the backup: it lives inside the sealed bundle, so leaving it behind
    // keeps `codesign --verify` failing even after the original file is back.
    fs.unlinkSync(backupFile);
  } else {
    const text = fs.readFileSync(mainFile, 'utf8');
    const stripped = stripInjection(text);
    if (stripped !== text) {
      fs.writeFileSync(mainFile, stripped, 'utf8');
      restoredFrom = 'injection-line removal';
    }
  }

  const sFile = stateFile(configDir);
  if (fs.existsSync(sFile)) fs.unlinkSync(sFile);

  return { appPath, mainFile, backupFile, restoredFrom };
}

module.exports = {
  MARKER,
  BACKUP_SUFFIX,
  injectionLine,
  findInjection,
  stripInjection,
  inspectPatch,
  applyPatch,
  restorePatch,
};
