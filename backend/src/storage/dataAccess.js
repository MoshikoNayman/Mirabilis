// @ts-check
// Reports data files the app cannot write (usually root-owned after a sudo
// launch), with the command that fixes them.

import { stat, access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

/** Files the app cannot work without. */
const CRITICAL_FILES = ['chats.json'];

/** Everything else it writes, worth reporting but not fatal. */
const OTHER_FILES = [
  'intelledger.json',
  'personal-memory.json',
  'config-vault.json',
  'homelab-hosts.json',
  'access.json',
  'connectors.json',
  'go-dark.json',
  'mcp-endpoint.json',
  'mcp-token'
];

/** A uid we can name is more useful than a number. */
function describeOwner(uid) {
  if (uid === 0) return 'root';
  if (typeof process.getuid === 'function' && uid === process.getuid()) return 'you';
  return `uid ${uid}`;
}

/**
 * The command that fixes an ownership problem.
 * @param {string} filePath
 */
function chownFix(filePath) {
  if (process.platform === 'win32') {
    return `takeown /F "${filePath}"`;
  }
  // $(id -un), not a literal name, so the pasted command is right for whoever runs it.
  return `sudo chown "$(id -un):$(id -gn)" "${filePath}"`;
}

/**
 * Translate a storage error into something worth showing a user.
 *
 * @param {any} error
 * @param {string} filePath
 * @returns {string}
 */
export function describeStorageError(error, filePath) {
  const code = error?.code;
  const name = path.basename(filePath || '');

  if (code === 'EACCES' || code === 'EPERM') {
    return `Mirabilis cannot write ${name}: the file exists but belongs to another user account. `
      + 'This happens when the app is launched once with sudo. Fix it with:\n'
      + `  ${chownFix(filePath)}`;
  }
  if (code === 'EROFS') {
    return `Mirabilis cannot write ${name}: the disk is read only. Move the data directory `
      + 'with MIRABILIS_DATA_DIR, or remount the volume.';
  }
  if (code === 'ENOSPC') {
    return `Mirabilis cannot write ${name}: the disk is full.`;
  }
  if (code === 'EMFILE' || code === 'ENFILE') {
    return `Mirabilis cannot open ${name}: too many open files on this system. Restart the app.`;
  }
  if (code === 'ENOTDIR') {
    return `Mirabilis cannot write ${name}: part of the path is a file, not a directory.`;
  }
  return error?.message || `Could not write ${name}.`;
}

/**
 * Boot-time check for data files that would fail on first use.
 *
 * @param {string} dir
 * @returns {Promise<{ ok: boolean, problems: Array<{ file: string, reason: string, fix: string, critical: boolean }> }>}
 */
export async function checkDataAccess(dir) {
  const problems = [];

  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    problems.push({
      file: dir,
      reason: `the data directory is not writable (${error?.code || 'error'})`,
      fix: chownFix(dir),
      critical: true
    });
    // No point checking files inside a directory we cannot enter.
    return { ok: false, problems };
  }

  for (const name of [...CRITICAL_FILES, ...OTHER_FILES]) {
    const full = path.join(dir, name);
    let info;
    try {
      info = await stat(full);
    } catch {
      continue; // absent is fine: it gets created on first write
    }
    try {
      await access(full, constants.R_OK | constants.W_OK);
    } catch (error) {
      problems.push({
        file: full,
        reason: `owned by ${describeOwner(info.uid)} and not writable by this process (${error?.code || 'EACCES'})`,
        fix: chownFix(full),
        critical: CRITICAL_FILES.includes(name)
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * A single block of text for the log and the startup dialog.
 * @param {Array<{file: string, reason: string, fix: string, critical: boolean}>} problems
 */
export function formatAccessProblems(problems) {
  if (!problems || problems.length === 0) return '';
  const lines = ['Mirabilis cannot use part of its data directory:', ''];
  for (const p of problems) {
    lines.push(`  ${p.critical ? '[blocking]' : '[warning] '} ${p.file}`);
    lines.push(`             ${p.reason}`);
    lines.push(`             fix: ${p.fix}`);
  }
  lines.push('');
  lines.push('This is almost always because the app was launched once with sudo.');
  return lines.join('\n');
}
