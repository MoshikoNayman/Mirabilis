// @ts-check
// Owner-only modes for everything the app writes. Guards against other local
// accounts, not against this user or offline disk access (use disk encryption).

import { chmod, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Owner read/write only. */
export const SECURE_FILE_MODE = 0o600;
/** Owner traverse only, so a directory listing is private too. */
export const SECURE_DIR_MODE = 0o700;

/** Best effort: a permission fix must never take the app down. */
export async function hardenFile(path) {
  try {
    await chmod(path, SECURE_FILE_MODE);
    return true;
  } catch {
    return false; // another platform, another owner, or already gone
  }
}

export async function ensureSecureDir(path) {
  try {
    await mkdir(path, { recursive: true, mode: SECURE_DIR_MODE });
    await chmod(path, SECURE_DIR_MODE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tighten existing files and directories under `dir` to owner-only modes.
 *
 * @param {string} dir
 * @param {number} [depth] how far to recurse (agent-runs lives one level down)
 */
export async function hardenExistingData(dir, depth = 2) {
  let changed = 0;
  const walk = async (current, level) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    await ensureSecureDir(current);
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (level > 0) await walk(full, level - 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(full);
        // Only touch files that are actually more permissive than they should be.
        if ((info.mode & 0o077) === 0) continue;
        if (await hardenFile(full)) changed += 1;
      } catch { /* raced with a delete */ }
    }
  };
  await walk(dir, depth);
  return { changed };
}
