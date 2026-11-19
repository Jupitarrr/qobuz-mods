'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ensureDir,
  writeJSONAtomic,
  copyDir,
  readJSON,
  rmrf,
} = require('../util');

const DEFAULT_CONFIG = {
  version: 1,
  enabled: {
    'now-playing': true,
  },
  options: {},
};

function readManifest(dir) {
  return readJSON(path.join(dir, 'mod.json'), {}) || {};
}

function ensureDefaultConfig(configDir) {
  ensureDir(configDir);
  const configFile = path.join(configDir, 'config.json');
  if (!fs.existsSync(configFile)) {
    writeJSONAtomic(configFile, DEFAULT_CONFIG);
  }
  return configFile;
}

function installRuntime({ repoRoot, configDir, force = false }) {
  ensureDir(configDir);

  const runtimeSrc = path.join(repoRoot, 'runtime');
  const runtimeDest = path.join(configDir, 'runtime');
  copyDir(runtimeSrc, runtimeDest, { overwrite: true });

  const modsSrc = path.join(repoRoot, 'mods');
  const modsDest = path.join(configDir, 'mods');
  ensureDir(modsDest);

  const bundledIds = new Set();
  if (fs.existsSync(modsSrc)) {
    for (const entry of fs.readdirSync(modsSrc, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = path.join(modsSrc, entry.name);
      const dest = path.join(modsDest, entry.name);
      const manifest = readManifest(src);
      const bundled = manifest.bundled === true || manifest.core === true;
      if (bundled) bundledIds.add(String(manifest.id || entry.name));

      // First-party mods track the framework; user mods are never clobbered
      // unless --force is passed.
      if (!fs.existsSync(dest) || force || bundled) {
        copyDir(src, dest, { overwrite: true });
      }
    }
  }

  // Remove first-party mods that were retired from the framework.
  for (const entry of fs.readdirSync(modsDest, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(modsDest, entry.name);
    const manifest = readManifest(dir);
    const id = String(manifest.id || entry.name);
    const bundled = manifest.bundled === true || manifest.core === true;
    if (bundled && !bundledIds.has(id)) {
      rmrf(dir);
    }
  }

  const configFile = ensureDefaultConfig(configDir);
  const config = readJSON(configFile, DEFAULT_CONFIG) || DEFAULT_CONFIG;
  config.enabled = config.enabled && typeof config.enabled === 'object' ? config.enabled : {};
  config.options = config.options && typeof config.options === 'object' ? config.options : {};

  // Prune stale config entries (for example, a retired bundled mod).
  const installedIds = new Set();
  for (const entry of fs.readdirSync(modsDest, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(path.join(modsDest, entry.name));
    installedIds.add(String(manifest.id || entry.name));
  }
  let changed = false;
  for (const id of Object.keys(config.enabled)) {
    if (!installedIds.has(id)) {
      delete config.enabled[id];
      changed = true;
    }
  }
  if (changed) writeJSONAtomic(configFile, config);

  return { runtimeDir: runtimeDest, modsDir: modsDest, configFile };
}

module.exports = {
  DEFAULT_CONFIG,
  ensureDefaultConfig,
  installRuntime,
};
