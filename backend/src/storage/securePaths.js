// @ts-check
// backend/src/storage/securePaths.js
// Every file this app writes holds something private.
//
// The stores were created with the process umask, which is normally 022, so they
// landed 0644: world readable. That put the entire chat history, the IntelLedger,
// the indexed config vault (which exists to hold the contents of config files,
// and config files are where credentials live) and the agent audit logs in reach
// of any other account on the machine. Only the two token files were protected,
// because those were the only ones written with an explicit mode.
//
// What this does NOT claim: it is not encryption, and it does not defend against
// something already running as this user. It closes the other-local-user and
// stray-copy cases, which are the ones a file mode can actually close. For
// protection against offline access to the disk, use whole-disk encryption
// (FileVault, BitLocker, LUKS), which is the right tool and already exists.

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
 * Bring an existing data directory up to the current standard.
 *
 * Without this the fix only applies to files written from now on, and every
 * machine already running keeps its world-readable history forever.
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
