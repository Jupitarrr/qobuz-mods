'use strict';

const { spawnSync } = require('node:child_process');

function plistValue(plistPath, key) {
  const result = spawnSync(
    'plutil',
    ['-extract', key, 'raw', '-o', '-', plistPath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim();
}

function setPlistString(plistPath, key, value) {
  const result = spawnSync(
    'plutil',
    ['-replace', key, '-string', String(value), plistPath],
    { encoding: 'utf8' },
  );
  if (result.status === 0) return;

  const add = spawnSync(
    'plutil',
    ['-insert', key, '-string', String(value), plistPath],
    { encoding: 'utf8' },
  );
  if (add.status !== 0) {
    const detail = (result.stderr || add.stderr || '').trim();
    throw new Error(`could not set ${key} in ${plistPath}${detail ? `: ${detail}` : ''}`);
  }
}

module.exports = { plistValue, setPlistString };
