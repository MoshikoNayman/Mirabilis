import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { readStore, writeStore, saveChat } from './chatStore.js';

async function tmpStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-chatstore-'));
  return path.join(dir, 'chats.json');
}

test('writeStore is atomic and leaves no temp file behind', async () => {
  const p = await tmpStore();
  await writeStore(p, { chats: [{ id: 'a', title: 'A', messages: [] }] });
  const back = await readStore(p);
  assert.equal(back.chats.length, 1);
  const siblings = await fs.readdir(path.dirname(p));
  assert.ok(!siblings.some((f) => f.includes('.tmp-')), 'temp file should be renamed away');
});

test('writeStore keeps a rolling .bak of the previous good copy', async () => {
  const p = await tmpStore();
  await writeStore(p, { chats: [{ id: 'first', title: 'first', messages: [] }] });
  await writeStore(p, { chats: [{ id: 'second', title: 'second', messages: [] }] });
  const bak = JSON.parse(await fs.readFile(`${p}.bak`, 'utf8'));
  assert.equal(bak.chats[0].id, 'first', '.bak should hold the prior version');
});

test('readStore recovers from .bak when the primary file is corrupt', async () => {
  // Seed files directly on disk - this models a fresh process after a torn write
  // (the in-memory cache is empty because the crashed process never updated it).
  const p = await tmpStore();
  await fs.writeFile(`${p}.bak`, JSON.stringify({ chats: [{ id: 'v1', title: 'v1', messages: [] }] }), 'utf8');
  await fs.writeFile(p, '{ "chats": [ {"id":"v2"', 'utf8'); // torn primary
  const recovered = await readStore(p);
  assert.equal(recovered.chats[0].id, 'v1', 'should fall back to the .bak copy');
});

test('readStore fails loudly (and quarantines) when corrupt with no backup', async () => {
  const p = await tmpStore();
  await fs.writeFile(p, 'not json at all', 'utf8'); // no prior write => no .bak
  await assert.rejects(() => readStore(p), /corrupt and no usable backup/);
  const siblings = await fs.readdir(path.dirname(p));
  assert.ok(siblings.some((f) => f.includes('.corrupt-')), 'corrupt file should be quarantined, not clobbered');
});

test('saveChat persists across an independent read (cache-invalidation sanity)', async () => {
  const p = await tmpStore();
  await writeStore(p, { chats: [] });
  await saveChat(p, { id: 'x', title: 'X', messages: [], updatedAt: new Date(0).toISOString() });
  const store = await readStore(p);
  assert.equal(store.chats.find((c) => c.id === 'x')?.title, 'X');
});
