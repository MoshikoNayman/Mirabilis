import fs from 'fs/promises';
import path from 'path';

const emptyStore = { chats: [] };

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
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return { ...emptyStore };
  }
}

export async function writeStore(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export async function listChats(filePath) {
  const store = await readStore(filePath);
  return store.chats
    .map((chat) => ({
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      messageCount: chat.messages.length
    }))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function getChat(filePath, chatId) {
  const store = await readStore(filePath);
  return store.chats.find((chat) => chat.id === chatId) || null;
}

export async function saveChat(filePath, nextChat) {
  const store = await readStore(filePath);
  const index = store.chats.findIndex((chat) => chat.id === nextChat.id);
  if (index >= 0) {
    store.chats[index] = nextChat;
  } else {
    store.chats.push(nextChat);
  }
  await writeStore(filePath, store);
}

export async function deleteChat(filePath, chatId) {
  const store = await readStore(filePath);
  const before = store.chats.length;
  store.chats = store.chats.filter((chat) => chat.id !== chatId);
  await writeStore(filePath, store);
  return store.chats.length < before;
}

export async function clearChats(filePath) {
  await writeStore(filePath, { ...emptyStore });
}
