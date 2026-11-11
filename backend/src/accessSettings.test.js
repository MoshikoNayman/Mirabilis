// The Access store: safe default, validation, owner-only atomic saves.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAccessStore, validateAccessPatch, AccessSettingsError, MAX_ALLOW_COMMANDS } from './accessSettings.js';

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-access-'));

test('a fresh store is Chat only with no rules', async () => {
  const store = createAccessStore(await tempDir());
  assert.deepEqual(await store.load(), { level: 'chat', allowCommands: [], updatedAt: null });
});

test('a change is saved to access.json, owner-only, and read back by a new store', async () => {
  const dir = await tempDir();
  const store = createAccessStore(dir);
  await store.load();
  const saved = await store.set({ level: 'ask', allowCommands: ['git status', '  npm   test '] });
  assert.equal(saved.level, 'ask');
  assert.deepEqual(saved.allowCommands, ['git status', 'npm test']);
  assert.ok(saved.updatedAt);

  const file = path.join(dir, 'access.json');
  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(onDisk, saved);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.includes('.tmp-')), [], 'no temp file left behind');

  const again = createAccessStore(dir);
  assert.deepEqual(await again.load(), saved);
});

test('unknown or unreadable contents read as Chat only', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'access.json');
  await fs.writeFile(file, JSON.stringify({ level: 'root', allowCommands: ['ok', 7, '', 'x'.repeat(200)] }));
  assert.deepEqual(await createAccessStore(dir).load(), { level: 'chat', allowCommands: ['ok'], updatedAt: null });

  await fs.writeFile(file, '{not json');
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal((await createAccessStore(dir).load()).level, 'chat');
  } finally {
    console.warn = warn;
  }
});

test('a bad change is refused with a plain reason and changes nothing', async () => {
  const store = createAccessStore(await tempDir());
  await store.load();
  const bad = [
    [{ level: 'root' }, /level must be one of: chat, read, ask, bypass/],
    [{ allowCommands: 'git status' }, /must be a list/],
    [{ allowCommands: [42] }, /must be text/],
    [{ allowCommands: ['   '] }, /1 to 120 characters/],
    [{ allowCommands: ['x'.repeat(121)] }, /1 to 120 characters/],
    [{ allowCommands: Array.from({ length: MAX_ALLOW_COMMANDS + 1 }, (_, i) => `cmd${i}`) }, /up to 200/],
    [null, /JSON object/],
    [['ask'], /JSON object/]
  ];
  for (const [patch, message] of bad) {
    await assert.rejects(() => store.set(patch), (err) => err instanceof AccessSettingsError && err.status === 400 && message.test(err.message));
  }
  assert.equal(store.get().level, 'chat');
  assert.deepEqual(validateAccessPatch({ allowCommands: ['a', 'a', 'b'] }), { allowCommands: ['a', 'b'] }, 'duplicates collapse');
  assert.deepEqual(validateAccessPatch({}), {});
});

test('a save that fails keeps the previous settings', async () => {
  const base = await tempDir();
  const notADir = path.join(base, 'not-a-directory');
  await fs.writeFile(notADir, 'x');
  const store = createAccessStore(path.join(notADir, 'nested'));
  const warn = console.warn;
  console.warn = () => {};
  try {
    await store.load();
  } finally {
    console.warn = warn;
  }
  await assert.rejects(() => store.set({ level: 'bypass' }));
  assert.equal(store.get().level, 'chat');
});

test('Always allow adds a rule once, dropping the oldest when the list is full', async () => {
  const store = createAccessStore(await tempDir());
  await store.load();
  await store.addAllowCommand('git status');
  await store.addAllowCommand('git status');
  assert.deepEqual(store.get().allowCommands, ['git status']);

  await store.set({ allowCommands: Array.from({ length: MAX_ALLOW_COMMANDS }, (_, i) => `cmd${i}`) });
  await store.addAllowCommand('make');
  const list = store.get().allowCommands;
  assert.equal(list.length, MAX_ALLOW_COMMANDS);
  assert.equal(list[0], 'cmd1');
  assert.equal(list.at(-1), 'make');
});

test('changes made at once end with the last one saved', async () => {
  const dir = await tempDir();
  const store = createAccessStore(dir);
  await store.load();
  await Promise.all(['read', 'ask', 'bypass', 'read'].map((level) => store.set({ level })));
  assert.equal(store.get().level, 'read');
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'access.json'), 'utf8')).level, 'read');
});
