'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { executableName } = require('../paths');

function commandResult(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

function stripQuarantine(appPath) {
  if (process.platform !== 'darwin') return false;
  const result = commandResult('xattr', ['-dr', 'com.apple.quarantine', appPath]);
  return result.ok;
}

function extractEntitlements(sourceApp) {
  if (process.platform !== 'darwin') return null;
  const dest = path.join(os.tmpdir(), `qobuz-mods-entitlements-${process.pid}.plist`);
  const result = commandResult('codesign', ['-d', '--entitlements', ':-', sourceApp]);
  const text = result.stdout.trim();
  if (!text) return null;
  fs.writeFileSync(dest, `${text}\n`, 'utf8');
  return dest;
}

function signAddon(addonPath) {
  if (process.platform !== 'darwin') return false;
  const result = commandResult('codesign', [
    '--force',
    '--options',
    'runtime',
    '--sign',
    '-',
    addonPath,
  ]);
  if (!result.ok) {
    throw new Error(`codesign addon failed: ${result.stderr.trim()}`);
  }
  return true;
}

function signApp(appPath, entitlementsPath) {
  if (process.platform !== 'darwin') return false;
  const args = ['--force', '--deep', '--options', 'runtime'];
  if (entitlementsPath && fs.existsSync(entitlementsPath)) {
    args.push('--entitlements', entitlementsPath);
  }
  args.push('--sign', '-', appPath);
  const result = commandResult('codesign', args);
  if (!result.ok) {
    throw new Error(`codesign app failed: ${result.stderr.trim()}`);
  }
  return true;
}

function verifyApp(appPath) {
  if (process.platform !== 'darwin') return { ok: true, output: '' };
  const result = commandResult('codesign', ['--verify', '--deep', '--strict', appPath]);
  return {
    ok: result.ok,
    output: `${result.stdout}${result.stderr}`.trim(),
  };
}

// Verifies the main executable's own signature while ignoring the bundle resource
// envelope, which the loader injection invalidates by design. The full `verifyApp`
// check is only meaningful right after re-signing.
function verifyExecutable(appPath) {
  if (process.platform !== 'darwin') return { ok: true, output: '' };
  const exe = path.join(appPath, 'Contents', 'MacOS', executableName(appPath));
  // `--ignore-resources` skips the sealed resource envelope while still validating
  // the executable's own code pages and requirements.
  const result = commandResult('codesign', [
    '--verify',
    '--strict',
    '--ignore-resources',
    exe,
  ]);
  return {
    ok: result.ok,
    executable: exe,
    output: `${result.stdout}${result.stderr}`.trim(),
  };
}

function signatureInfo(appPath) {
  if (process.platform !== 'darwin') return null;
  const result = commandResult('codesign', ['-dv', '--verbose=4', appPath]);
  const text = `${result.stdout}${result.stderr}`;
  const pick = (key) => {
    const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return match ? match[1].trim() : null;
  };
  const authorities = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^Authority=(.*)$/);
    if (match) authorities.push(match[1].trim());
  }
  const signature = pick('Signature');
  return {
    identifier: pick('Identifier'),
    format: pick('Format'),
    signature,
    // `codesign -dv` prints `Signature size=N` for Developer ID signatures and
    // `Signature=adhoc` for ad-hoc ones; only the latter yields a value above.
    signatureType:
      signature === 'adhoc' ? 'adhoc' : authorities.length ? 'developer-id' : 'unknown',
    authorities,
    teamIdentifier: pick('TeamIdentifier'),
    cdhash: pick('CDHash'),
    runtime: pick('Runtime Version'),
  };
}

function registerWithLaunchServices(appPath) {
  if (process.platform !== 'darwin') return;
  const tool =
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  if (!fs.existsSync(tool)) return;
  commandResult(tool, ['-f', appPath]);
}

module.exports = {
  commandResult,
  stripQuarantine,
  extractEntitlements,
  signAddon,
  signApp,
  verifyApp,
  verifyExecutable,
  signatureInfo,
  registerWithLaunchServices,
};
