// Atomic JSON storage for Homelab Roster hosts. Passwords are never stored;
// password auth is entered at connect time.

import fs from 'fs/promises';
import path from 'path';
import { hardenFile, SECURE_FILE_MODE } from './securePaths.js';
import { randomUUID } from 'node:crypto';

const emptyStore = { hosts: [] };

const HOST_TYPES = ['router', 'nas', 'server', 'pi', 'other'];
const AUTH_TYPES = ['agent', 'key', 'password'];
const HOSTNAME_RE = /^[a-zA-Z0-9._-]+$/;

// Read cache, invalidated on every write.
let _cache = null;
let _cachePath = null;

function invalidateCache() {
  _cache = null;
  _cachePath = null;
}

// Serializes writes so concurrent read-modify-write cycles cannot lose data.
let _lock = Promise.resolve();
function withLock(fn) {
  let release;
  const ticket = new Promise((resolve) => { release = resolve; });
  const prev = _lock;
  _lock = ticket;
  return prev.then(() => fn()).finally(() => release());
}

async function ensureStoreFile(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(emptyStore, null, 2), 'utf8');
  }
}

async function readStore(filePath) {
  await ensureStoreFile(filePath);
  if (_cache && _cachePath === filePath) return _cache;
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    _cache = JSON.parse(raw);
    if (!Array.isArray(_cache.hosts)) _cache = { hosts: [] };
    _cachePath = filePath;
    return _cache;
  } catch (parseError) {
    // Corrupt primary: fall back to .bak so the next write cannot destroy hosts.
    try {
      const backupRaw = await fs.readFile(`${filePath}.bak`, 'utf8');
      _cache = JSON.parse(backupRaw);
      if (!Array.isArray(_cache.hosts)) _cache = { hosts: [] };
      _cachePath = filePath;
      try {
        const healTmp = `${filePath}.heal-${process.pid}`;
        await fs.writeFile(healTmp, backupRaw, 'utf8');
        await fs.rename(healTmp, filePath);
      } catch { /* best effort: cache already holds good data */ }
      console.warn(`[homelabStore] ${filePath} was corrupt; recovered from ${filePath}.bak and healed the primary`);
      return _cache;
    } catch {
      const quarantine = `${filePath}.corrupt-${Date.now()}`;
      try { await fs.rename(filePath, quarantine); } catch { /* best effort */ }
      throw new Error(
        `Homelab store at ${filePath} is corrupt and no usable backup exists. ` +
        `The unreadable file was moved to ${quarantine}. Original error: ${parseError.message}`
      );
    }
  }
}

// Temp file, fsync, rename. Keeps the previous copy as .bak, except on
// { shred: true }, which removes data by intent and must not leave a copy.
async function writeStore(filePath, data, { shred = false } = {}) {
  invalidateCache();
  const serialized = JSON.stringify(data, null, 2);
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
  _cache = data;
  _cachePath = filePath;
}

// Returns { host } or { error }. Never keeps a password field.
export function normalizeHost(input) {
  const raw = input || {};
  const host = String(raw.host || '').trim();
  if (!host || !HOSTNAME_RE.test(host)) {
    return { error: 'Invalid host (letters, digits, dot, dash, underscore only)' };
  }
  const port = Number(raw.port || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: 'Invalid port (1-65535)' };
  }
  const type = HOST_TYPES.includes(raw.type) ? raw.type : 'other';
  const authType = AUTH_TYPES.includes(raw.authType) ? raw.authType : 'agent';
  const label = String(raw.label || '').trim().slice(0, 120) || host;
  const user = String(raw.user || '').trim().slice(0, 120);
  const keyPath = authType === 'key' ? String(raw.keyPath || '').trim().slice(0, 1024) : '';

  const record = {
    id: randomUUID(),
    label,
    host,
    port,
    type,
    user,
    authType
  };
  if (keyPath) record.keyPath = keyPath;
  return { host: record };
}

export async function listHosts(filePath) {
  const store = await readStore(filePath);
  return store.hosts.slice();
}

export function addHost(filePath, input) {
  const normalized = normalizeHost(input);
  if (normalized.error) return Promise.resolve(normalized);
  return withLock(async () => {
    const store = await readStore(filePath);
    store.hosts.push(normalized.host);
    await writeStore(filePath, store);
    return { host: normalized.host };
  });
}

export function deleteHost(filePath, id) {
  return withLock(async () => {
    const store = await readStore(filePath);
    const before = store.hosts.length;
    store.hosts = store.hosts.filter((h) => h.id !== id);
    await writeStore(filePath, store, { shred: true });
    return store.hosts.length < before;
  });
}
