import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  readStore, writeStore, saveChat, clearChats, deleteChat,
  listChats, getChat, getEpoch, isEphemeralChat
} from './chatStore.js';

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

// ── clearChats / deleteChat: the paths that shipped a data-loss and a privacy bug ──

test('clearChats empties the store, twice in a row, in one process', async () => {
  const p = await tmpStore();
  // Run the whole cycle TWICE. The original bug only appeared on the second
  // pass: clearChats wrote `{ ...emptyStore }`, which aliased the module-level
  // emptyStore.chats array, so the saveChat below push()ed onto the shared
  // template and every later "empty" write silently carried the old chat.
  for (const round of ['first', 'second']) {
    await saveChat(p, { id: `c-${round}`, title: round, messages: [], updatedAt: new Date().toISOString() });
    assert.equal((await readStore(p)).chats.length, 1, `${round}: chat should be saved`);
    await clearChats(p);
    assert.deepEqual((await readStore(p)).chats, [], `${round}: store should be empty after clear`);
  }
});

test('clearChats shreds the .bak so deleted chats do not survive on disk', async () => {
  const p = await tmpStore();
  await saveChat(p, { id: 'secret', title: 'private notes', messages: [], updatedAt: new Date().toISOString() });
  await saveChat(p, { id: 'secret2', title: 'more private notes', messages: [], updatedAt: new Date().toISOString() });
  // A .bak exists at this point precisely because normal writes roll one.
  const bakBefore = await fs.readFile(`${p}.bak`, 'utf8');
  assert.ok(bakBefore.includes('private notes'), 'precondition: .bak holds the data');

  await clearChats(p);

  await assert.rejects(
    () => fs.readFile(`${p}.bak`, 'utf8'),
    /ENOENT/,
    'clear must remove the backup, or "delete my chats" leaves a full copy on disk'
  );
});

test('deleteChat removes one chat and shreds the .bak', async () => {
  const p = await tmpStore();
  await saveChat(p, { id: 'keep', title: 'keep', messages: [], updatedAt: new Date().toISOString() });
  await saveChat(p, { id: 'drop', title: 'sensitive', messages: [], updatedAt: new Date().toISOString() });

  assert.equal(await deleteChat(p, 'drop'), true, 'should report it deleted something');
  const store = await readStore(p);
  assert.deepEqual(store.chats.map((c) => c.id), ['keep']);
  await assert.rejects(() => fs.readFile(`${p}.bak`, 'utf8'), /ENOENT/, 'deleted chat must not survive in .bak');
});

test('deleteChat returns false for an unknown id and leaves the store intact', async () => {
  const p = await tmpStore();
  await saveChat(p, { id: 'a', title: 'A', messages: [], updatedAt: new Date().toISOString() });
  assert.equal(await deleteChat(p, 'does-not-exist'), false);
  assert.equal((await readStore(p)).chats.length, 1);
});

// ── epoch guard: a save already in flight must not resurrect a cleared store ──

test('getEpoch advances on clear, and a save enqueued before the clear is dropped', async () => {
  const p = await tmpStore();
  await writeStore(p, { chats: [] });
  const before = getEpoch();

  // Start a save and a clear without awaiting the save first, so the save is
  // queued behind the clear on the shared write lock. Driven by the epoch, not
  // by a sleep, so it cannot flake on a slow machine.
  const pendingSave = saveChat(p, { id: 'ghost', title: 'ghost', messages: [], updatedAt: new Date().toISOString() });
  const pendingClear = clearChats(p);
  await Promise.all([pendingSave, pendingClear]);

  assert.ok(getEpoch() > before, 'clear must advance the epoch');
  assert.deepEqual((await readStore(p)).chats, [], 'a save from before the clear must not resurrect data');
});

// ── Off-the-Record: ephemeral chats must never reach disk ──

test('ephemeral chats stay in memory and never touch the store file', async () => {
  const p = await tmpStore();
  await writeStore(p, { chats: [] });
  await saveChat(p, { id: 'otr', title: 'off the record', messages: [], ephemeral: true, updatedAt: new Date().toISOString() });

  assert.equal(isEphemeralChat('otr'), true, 'should be tracked as ephemeral');
  assert.equal((await readStore(p)).chats.length, 0, 'ephemeral chat must not be written to disk');

  const raw = await fs.readFile(p, 'utf8');
  assert.ok(!raw.includes('off the record'), 'ephemeral title must not appear in the file');

  // It still behaves like a real chat while the process lives.
  assert.equal((await getChat(p, 'otr'))?.title, 'off the record');
  assert.ok((await listChats(p)).some((c) => c.id === 'otr' && c.ephemeral === true));

  assert.equal(await deleteChat(p, 'otr'), true);
  assert.equal(await getChat(p, 'otr'), null);
});
