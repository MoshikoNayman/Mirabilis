// backend/src/storage/configVaultStore.js
// Persistent index for the Config Vault: a folder of network/homelab config files
// turned into embedded, citable chunks. Unlike the Recall Orb (which rebuilds its
// corpus in memory every query), the Vault persists vectors to disk so a restart
// can answer queries without re-embedding a large config corpus. Mirrors the
// atomic-write discipline of homelabStore.js: single write lock + temp file +
// fsync + rename, with a .bak kept as the last-known-good copy.

import fs from 'fs/promises';
import path from 'path';

const emptyStore = { root: '', builtAt: null, embedModel: null, fileCount: 0, chunks: [] };

let _cache = null;
let _cachePath = null;

function invalidateCache() {
  _cache = null;
  _cachePath = null;
}

let _lock = Promise.resolve();
function withLock(fn) {
  let release;
  const ticket = new Promise((resolve) => { release = resolve; });
  const prev = _lock;
  _lock = ticket;
  return prev.then(() => fn()).finally(() => release());
}

function coerce(obj) {
  const store = obj && typeof obj === 'object' ? obj : {};
  return {
    root: typeof store.root === 'string' ? store.root : '',
    builtAt: store.builtAt || null,
    embedModel: store.embedModel || null,
    fileCount: Number.isFinite(store.fileCount) ? store.fileCount : 0,
    chunks: Array.isArray(store.chunks) ? store.chunks : []
  };
}

async function ensureStoreFile(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(emptyStore, null, 2), 'utf8');
  }
}

export async function readVault(filePath) {
  await ensureStoreFile(filePath);
  // Lock-free fast path for a warm cache.
  if (_cache && _cachePath === filePath) return _cache;
  // Cold read runs under the same lock as writeVault so a concurrent re-index can
  // never interleave between our fs.readFile and the cache assignment (which would
  // otherwise clobber the writer's fresh cache with stale data). Double-checked:
  // if a write completed while we waited for the lock, return its cache instead.
  return withLock(async () => {
    if (_cache && _cachePath === filePath) return _cache;
    const raw = await fs.readFile(filePath, 'utf8');
    try {
      _cache = coerce(JSON.parse(raw));
      _cachePath = filePath;
      return _cache;
    } catch (parseError) {
      try {
        const backupRaw = await fs.readFile(`${filePath}.bak`, 'utf8');
        _cache = coerce(JSON.parse(backupRaw));
        _cachePath = filePath;
        console.warn(`[configVaultStore] ${filePath} was corrupt; recovered from ${filePath}.bak`);
        return _cache;
      } catch {
        const quarantine = `${filePath}.corrupt-${Date.now()}`;
        try { await fs.rename(filePath, quarantine); } catch { /* best effort */ }
        throw new Error(
          `Config Vault store at ${filePath} is corrupt and no usable backup exists. ` +
          `The unreadable file was moved to ${quarantine}. Original error: ${parseError.message}`
        );
      }
    }
  });
}

export function writeVault(filePath, data) {
  return withLock(async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    invalidateCache();
    const next = coerce(data);
    const serialized = JSON.stringify(next, null, 2);
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    const handle = await fs.open(tmpPath, 'w');
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try { await fs.copyFile(filePath, `${filePath}.bak`); } catch { /* first write: no prior file */ }
    await fs.rename(tmpPath, filePath);
    _cache = next;
    _cachePath = filePath;
    return next;
  });
}

export async function clearVault(filePath) {
  return writeVault(filePath, { ...emptyStore });
}
