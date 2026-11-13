// /api/access: the guard, the response shape, and validation of a change.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createAccessRouter } from './access.js';
import { createAccessStore } from '../accessSettings.js';
import { makePrivilegedGuard } from '../security.js';

const TOKEN = 'test-token-access';
const servers = [];

async function serve({ platform } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-access-route-'));
  const store = createAccessStore(dataDir);
  await store.load();
  const app = express();
  app.use('/api/access', createAccessRouter({
    store, guard: makePrivilegedGuard(TOKEN, 'access settings'), sourceRoot: '/src/root', dataDir, platform, goDark: () => false
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const url = `http://127.0.0.1:${server.address().port}/api/access`;
  return { url, dataDir, store };
}

after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

const auth = { Authorization: `Bearer ${TOKEN}` };
const put = (url, body, raw) => fetch(url, {
  method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: raw ?? JSON.stringify(body)
});

test('without the session token every call is refused', async () => {
  const { url } = await serve();
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"level":"bypass"}' })).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
});

test('GET returns the level, the four levels, rules, read-only programs and where things live', async () => {
  const { url, dataDir } = await serve();
  const body = await (await fetch(url, { headers: auth })).json();
  assert.equal(body.level, 'chat');
  assert.deepEqual(body.levels.map((l) => l.id), ['chat', 'read', 'ask', 'bypass']);
  for (const l of body.levels) {
    assert.ok(l.label, `${l.id} needs a label`);
  }
  assert.deepEqual(body.allowCommands, []);
  for (const prog of ['ps', 'df', 'git', 'lsof']) assert.ok(body.readOnlyPrograms.includes(prog), prog);
  assert.equal(body.goDark, false);
  assert.equal(body.sourceRoot, '/src/root');
  assert.equal(body.dataDir, dataDir);
});

test('PUT changes the level and the rules, and they are saved', async () => {
  const { url, dataDir } = await serve();
  const res = await put(url, { level: 'ask', allowCommands: ['git status', 'git status', 'npm test'] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.level, 'ask');
  assert.deepEqual(body.allowCommands, ['git status', 'npm test']);
  assert.equal(body.levels.length, 4, 'PUT answers in the same shape as GET');
  const onDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'access.json'), 'utf8'));
  assert.equal(onDisk.level, 'ask');

  const levelOnly = await (await put(url, { level: 'bypass' })).json();
  assert.equal(levelOnly.level, 'bypass');
  assert.deepEqual(levelOnly.allowCommands, ['git status', 'npm test'], 'a field left out is kept');
});

test('a bad change is a 400 with a plain reason', async () => {
  const { url, store } = await serve();
  const cases = [
    { level: 'admin' },
    { allowCommands: 'git status' },
    { allowCommands: [''] },
    { allowCommands: ['x'.repeat(121)] },
    { allowCommands: Array.from({ length: 201 }, (_, i) => `c${i}`) }
  ];
  for (const body of cases) {
    const res = await put(url, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(typeof (await res.json()).error, 'string');
  }
  const malformed = await put(url, null, '{"level":');
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /not valid JSON/);
  assert.equal(store.get().level, 'chat', 'nothing changed');
});

test('on Windows the read-only list is the Windows one', async () => {
  const { url } = await serve({ platform: 'win32' });
  const body = await (await fetch(url, { headers: auth })).json();
  assert.ok(body.readOnlyPrograms.includes('ipconfig'));
  assert.ok(!body.readOnlyPrograms.includes('lsof'));
});

test('the router refuses to mount without a guard', () => {
  assert.throws(() => createAccessRouter({ store: createAccessStore(os.tmpdir()), guard: undefined, sourceRoot: '/', dataDir: '/' }), /privileged guard/);
});
