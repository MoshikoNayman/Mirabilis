import fs from 'fs/promises';
import path from 'path';

const emptyStore = { chats: [] };

// Module-level read cache - invalidated on every write so reads within the same
// request cycle never hit the filesystem more than once.
let _cache = null;
let _cachePath = null;

// Monotonically-incrementing epoch. Incremented on every clearChats so that any
// saveChat enqueued BEFORE the clear (or finishing AFTER it) recognises the store
// was wiped and bails out, preventing cleared chats from being resurrected.
let _epoch = 0;

// Off-the-Record: ephemeral chats live only in this in-memory map and are never
// written to disk. They work normally within a running session (send, stream,
// rename) but are gone the moment the backend process exits - no chats.json trace.
const _ephemeral = new Map();

export function isEphemeralChat(chatId) {
  return _ephemeral.has(chatId);
}

function invalidateCache() {
  _cache = null;
  _cachePath = null;
}

// Serializes all write operations to prevent concurrent read-modify-write data loss
let _lock = Promise.resolve();
function withLock(fn) {
  let release;
  const ticket = new Promise((resolve) => { release = resolve; });
  const prev = _lock;
  _lock = ticket;
  return prev.then(() => fn()).finally(() => release());
}

export async function ensureStoreFile(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(emptyStore, null, 2), 'utf8');
  }
}

export async function readStore(filePath) {
  await ensureStoreFile(filePath);
  if (_cache && _cachePath === filePath) return _cache;
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    _cache = JSON.parse(raw);
    _cachePath = filePath;
    return _cache;
  } catch (parseError) {
    // The primary file is corrupt (truncated write, disk-full, etc.). Try the
    // last-known-good backup before giving up - silently returning empty here
    // would let the next write overwrite the corrupt file and destroy chats.
    try {
      const backupRaw = await fs.readFile(`${filePath}.bak`, 'utf8');
      _cache = JSON.parse(backupRaw);
      _cachePath = filePath;
      // Heal the corrupt primary immediately (temp + rename, leaving the good
      // .bak untouched) so a later write doesn't roll the corrupt file into .bak.
      try {
        const healTmp = `${filePath}.heal-${process.pid}`;
        await fs.writeFile(healTmp, backupRaw, 'utf8');
        await fs.rename(healTmp, filePath);
      } catch { /* best effort - cache already holds good data */ }
      console.warn(`[chatStore] ${filePath} was corrupt; recovered from ${filePath}.bak and healed the primary`);
      return _cache;
    } catch {
      // Quarantine the corrupt file instead of clobbering it, then fail loud so
      // the user notices rather than losing everything silently.
      const quarantine = `${filePath}.corrupt-${Date.now()}`;
      try { await fs.rename(filePath, quarantine); } catch { /* best effort */ }
      throw new Error(
        `Chat store at ${filePath} is corrupt and no usable backup exists. ` +
        `The unreadable file was moved to ${quarantine}. Original error: ${parseError.message}`
      );
    }
  }
}

// Atomic write: serialize to a temp file, fsync, then rename over the target
// (atomic on POSIX). A crash mid-write leaves either the old file or the new
// file intact - never a truncated one. The previous good copy is kept as .bak.
export async function writeStore(filePath, data) {
  invalidateCache();
  const serialized = JSON.stringify(data);
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  const handle = await fs.open(tmpPath, 'w');
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Roll the current good file to .bak before replacing it.
  try { await fs.copyFile(filePath, `${filePath}.bak`); } catch { /* first write: no prior file */ }
  await fs.rename(tmpPath, filePath);
  _cache = data;
  _cachePath = filePath;
}

function summarizeChat(chat, ephemeral) {
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    messageCount: chat.messages.length,
    snapshotCount: Array.isArray(chat.snapshots) ? chat.snapshots.length : 0,
    parentChatId: chat.parentChatId || '',
    branchLabel: chat.branchLabel || '',
    ephemeral: ephemeral === true
  };
}

export async function listChats(filePath) {
  const store = await readStore(filePath);
  const persisted = store.chats.map((chat) => summarizeChat(chat, chat.ephemeral));
  const ephemeral = [..._ephemeral.values()].map((chat) => summarizeChat(chat, true));
  return [...persisted, ...ephemeral]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function getChat(filePath, chatId) {
  if (_ephemeral.has(chatId)) return _ephemeral.get(chatId);
  const store = await readStore(filePath);
  return store.chats.find((chat) => chat.id === chatId) || null;
}

export function saveChat(filePath, nextChat) {
  // Off-the-Record: keep ephemeral chats in memory only, never touch disk.
  if (nextChat?.ephemeral) {
    _ephemeral.set(nextChat.id, nextChat);
    return Promise.resolve(nextChat);
  }
  // Snapshot epoch before entering the queue. If clearChats runs while this
  // saveChat is waiting, the epoch will have incremented and we skip the write.
  const savedEpoch = _epoch;
  return withLock(async () => {
    if (_epoch !== savedEpoch) return; // store was cleared after this save was enqueued
    const store = await readStore(filePath);
    const index = store.chats.findIndex((chat) => chat.id === nextChat.id);
    if (index >= 0) {
      store.chats[index] = nextChat;
    } else {
      store.chats.push(nextChat);
    }
    await writeStore(filePath, store);
  });
}

export function deleteChat(filePath, chatId) {
  if (_ephemeral.delete(chatId)) return Promise.resolve(true);
  return withLock(async () => {
    const store = await readStore(filePath);
    const before = store.chats.length;
    store.chats = store.chats.filter((chat) => chat.id !== chatId);
    await writeStore(filePath, store);
    return store.chats.length < before;
  });
}

export function clearChats(filePath) {
  return withLock(async () => {
    _epoch++; // invalidate all in-flight saveChat calls
    await writeStore(filePath, { ...emptyStore });
  });
}

// Returns the current epoch so callers can detect if clearChats ran since they
// last checked.
export function getEpoch() {
  return _epoch;
}
