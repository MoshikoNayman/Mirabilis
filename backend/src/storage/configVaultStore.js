// backend/src/storage/configVaultStore.js
// Persistent index for the Config Vault: a folder of network/homelab config files
// turned into embedded, citable chunks. Unlike the Recall Orb (which rebuilds its
// corpus in memory every query), the Vault persists vectors to disk so a restart
// can answer queries without re-embedding a large config corpus. Mirrors the
// atomic-write discipline of homelabStore.js: single write lock + temp file +
// fsync + rename, with a .bak kept as the last-known-good copy.

import fs from 'fs/promises';
import path from 'path';
import { hardenFile, SECURE_FILE_MODE } from './securePaths.js';

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

// Embedding vectors dominate this file: 896 float64s per chunk, and at the
// 20,000-chunk ceiling the store measured 25.1 KB per chunk, which projects to
// roughly 514 MB of JSON held in memory, re-serialized and copied to .bak on
// every write.
//
// Two cheap changes cut that to about 180 MB with no format change, so existing
// files still load: write compact JSON (no pretty-print), and round vector
// components to 6 decimals. Measured worst-case cosine error from the rounding
// is 1.8e-09, which cannot affect ranking. Full precision here was storing 17
// significant digits of a number whose useful precision is far lower.
const VECTOR_DECIMALS = 6;

function compactVector(vector) {
  if (!Array.isArray(vector)) return vector;
  const out = new Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    const v = vector[i];
    out[i] = typeof v === 'number' ? Number(v.toFixed(VECTOR_DECIMALS)) : v;
  }
  return out;
}

function coerce(obj) {
  const store = obj && typeof obj === 'object' ? obj : {};
  return {
    root: typeof store.root === 'string' ? store.root : '',
    builtAt: store.builtAt || null,
    embedModel: store.embedModel || null,
    fileCount: Number.isFinite(store.fileCount) ? store.fileCount : 0,
    chunks: Array.isArray(store.chunks)
      ? store.chunks.map((c) => (c && c.vector ? { ...c, vector: compactVector(c.vector) } : c))
      : []
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

export function writeVault(filePath, data, { shred = false } = {}) {
  return withLock(async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    invalidateCache();
    const next = coerce(data);
    // Compact, not pretty: this file is machine-read only, and the indentation
    // alone accounted for roughly a third of its size.
    const serialized = JSON.stringify(next);
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    const handle = await fs.open(tmpPath, 'w', SECURE_FILE_MODE);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (shred) {
      await fs.rename(tmpPath, filePath);
      await fs.unlink(`${filePath}.bak`).catch(() => { /* no prior backup */ });
    } else {
      try { await fs.copyFile(filePath, `${filePath}.bak`); } catch { /* first write: no prior file */ }
      await fs.rename(tmpPath, filePath);
    }
    await hardenFile(filePath);
    _cache = next;
    _cachePath = filePath;
    return next;
  });
}

export async function clearVault(filePath) {
  // Build a fresh empty store rather than spreading the module-level template:
  // `{ ...emptyStore }` aliases emptyStore.chunks, so a later push() would
  // pollute the shared "empty" value for the rest of the process lifetime.
  // Shred the .bak too, or the whole indexed corpus survives the clear.
  return writeVault(filePath, { root: '', builtAt: null, embedModel: null, fileCount: 0, chunks: [] }, { shred: true });
}
