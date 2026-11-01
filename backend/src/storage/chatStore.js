import fs from 'fs/promises';
import path from 'path';
import { hardenFile, SECURE_FILE_MODE } from './securePaths.js';

const emptyStore = { chats: [] };

// Read cache, replaced on every write.
let _cache = null;
let _cachePath = null;

// Bumped by clearChats so a saveChat queued before the clear cannot resurrect chats.
let _epoch = 0;

// Off-the-Record chats live only here and never touch disk.
const _ephemeral = new Map();

export function isEphemeralChat(chatId) {
  return _ephemeral.has(chatId);
}

function invalidateCache() {
  _cache = null;
  _cachePath = null;
}

// Serializes read-modify-write cycles so concurrent writes cannot lose data.
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
    // Corrupt primary: fall back to .bak. Returning empty would let the next write destroy chats.
    try {
      const backupRaw = await fs.readFile(`${filePath}.bak`, 'utf8');
      _cache = JSON.parse(backupRaw);
      _cachePath = filePath;
      // Heal the primary now so a later write cannot roll the corrupt file into .bak.
      try {
        const healTmp = `${filePath}.heal-${process.pid}`;
        await fs.writeFile(healTmp, backupRaw, 'utf8');
        await fs.rename(healTmp, filePath);
      } catch { /* best effort: cache already holds good data */ }
      console.warn(`[chatStore] ${filePath} was corrupt; recovered from ${filePath}.bak and healed the primary`);
      return _cache;
    } catch {
      // Quarantine the corrupt file and throw rather than overwrite it.
      const quarantine = `${filePath}.corrupt-${Date.now()}`;
      try { await fs.rename(filePath, quarantine); } catch { /* best effort */ }
      throw new Error(
        `Chat store at ${filePath} is corrupt and no usable backup exists. ` +
        `The unreadable file was moved to ${quarantine}. Original error: ${parseError.message}`
      );
    }
  }
}

// Atomic write (temp, fsync, rename); the previous good copy is kept as .bak.
// Pass { shred: true } for deletes and purges: it drops .bak so removed data does not survive there.
export async function writeStore(filePath, data, { shred = false } = {}) {
  invalidateCache();
  const serialized = JSON.stringify(data);
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
  if (nextChat?.ephemeral) {
    _ephemeral.set(nextChat.id, nextChat);
    return Promise.resolve(nextChat);
  }
  // Capture the epoch before queueing; a clear in between skips this write.
  const savedEpoch = _epoch;
  return withLock(async () => {
    if (_epoch !== savedEpoch) return;
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
    await writeStore(filePath, store, { shred: true });
    return store.chats.length < before;
  });
}

export function clearChats(filePath) {
  return withLock(async () => {
    _epoch++;
    // Fresh array: `{ ...emptyStore }` would alias emptyStore.chats and later saves would push onto it.
    await writeStore(filePath, { chats: [] }, { shred: true });
  });
}

// Lets callers detect a clearChats since they last checked.
export function getEpoch() {
  return _epoch;
}
