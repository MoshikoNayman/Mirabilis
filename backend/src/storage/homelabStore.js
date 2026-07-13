// backend/src/storage/homelabStore.js
// Atomic JSON storage for the Homelab Roster: the user's own machines (routers,
// NAS, servers, a Raspberry Pi) saved as ICQ-style buddy contacts. Mirrors the
// chatStore.js style: a single write lock plus temp-file + fsync + rename so a
// crash mid-write never leaves a truncated file. Passwords are NEVER persisted
// here - password auth is entered at connect time only.

import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'node:crypto';

const emptyStore = { hosts: [] };

const HOST_TYPES = ['router', 'nas', 'server', 'pi', 'other'];
const AUTH_TYPES = ['agent', 'key', 'password'];
const HOSTNAME_RE = /^[a-zA-Z0-9._-]+$/;

// Module-level read cache - invalidated on every write so reads within the same
// request cycle never hit the filesystem more than once.
let _cache = null;
let _cachePath = null;

function invalidateCache() {
  _cache = null;
  _cachePath = null;
}

// Serializes all write operations to prevent concurrent read-modify-write data loss.
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
    // The primary file is corrupt. Try the last-known-good backup before giving
    // up so a later write does not overwrite the corrupt file and destroy hosts.
    try {
      const backupRaw = await fs.readFile(`${filePath}.bak`, 'utf8');
      _cache = JSON.parse(backupRaw);
      if (!Array.isArray(_cache.hosts)) _cache = { hosts: [] };
      _cachePath = filePath;
      try {
        const healTmp = `${filePath}.heal-${process.pid}`;
        await fs.writeFile(healTmp, backupRaw, 'utf8');
        await fs.rename(healTmp, filePath);
      } catch { /* best effort - cache already holds good data */ }
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

// Atomic write: serialize to a temp file, fsync, then rename over the target
// (atomic on POSIX). The previous good copy is kept as .bak.
async function writeStore(filePath, data) {
  invalidateCache();
  const serialized = JSON.stringify(data, null, 2);
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
  _cache = data;
  _cachePath = filePath;
}

// Normalize + validate an incoming host. Returns { host } on success or
// { error } with a human-readable message. NEVER keeps a password field.
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
    await writeStore(filePath, store);
    return store.hosts.length < before;
  });
}
