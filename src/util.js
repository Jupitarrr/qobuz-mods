'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSONAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function runInherit(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function expandHome(input) {
  if (!input) return input;
  if (input === '~') return process.env.HOME;
  if (input.startsWith('~/')) return path.join(process.env.HOME, input.slice(2));
  return input;
}

function copyDir(src, dest, { overwrite = true } = {}) {
  const stat = fs.statSync(src);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(src);
    ensureDir(path.dirname(dest));
    try {
      fs.unlinkSync(dest);
    } catch {
      // Nothing to remove.
    }
    fs.symlinkSync(target, dest);
    return;
  }
  if (stat.isDirectory()) {
    ensureDir(dest);
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      copyDir(path.join(src, entry.name), path.join(dest, entry.name), { overwrite });
    }
    return;
  }
  if (!overwrite && fs.existsSync(dest)) return;
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function tailFile(file, lines = 20) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

module.exports = {
  ensureDir,
  readJSON,
  writeJSONAtomic,
  sha256,
  fileSha256,
  run,
  runInherit,
  expandHome,
  copyDir,
  rmrf,
  tailFile,
  formatBytes,
};
