'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ensureDir, writeJSONAtomic, copyDir, readJSON } = require('../util');

const DEFAULT_CONFIG = {
  version: 1,
  enabled: {
    'now-playing': true,
    'last-played': true,
  },
  options: {},
};

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

  if (fs.existsSync(modsSrc)) {
    for (const entry of fs.readdirSync(modsSrc, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = path.join(modsSrc, entry.name);
      const dest = path.join(modsDest, entry.name);
      const manifest = readJSON(path.join(src, 'mod.json'), {}) || {};
      // First-party mods track the framework; user mods are never clobbered
      // unless --force is passed.
      const bundled = manifest.bundled === true || manifest.core === true;
      if (!fs.existsSync(dest) || force || bundled) {
        copyDir(src, dest, { overwrite: true });
      }
    }
  }

  const configFile = ensureDefaultConfig(configDir);
  return { runtimeDir: runtimeDest, modsDir: modsDest, configFile };
}

module.exports = {
  DEFAULT_CONFIG,
  ensureDefaultConfig,
  installRuntime,
};
