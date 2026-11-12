// The MCP server switch: on by default, owner-only atomic saves, plain refusals.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMcpEndpointStore, McpEndpointError, MCP_ENDPOINT_FILE } from './mcpEndpoint.js';

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-mcp-endpoint-'));

/** @param {() => Promise<any>} fn */
async function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}

test('a fresh store is on', async () => {
  const store = createMcpEndpointStore(await tempDir());
  assert.deepEqual(await store.load(), { enabled: true, updatedAt: null });
  assert.equal(store.isEnabled(), true);
});

test('off is saved to mcp-endpoint.json, owner-only, and read back by a new store', async () => {
  const dir = await tempDir();
  const store = createMcpEndpointStore(dir);
  await store.load();
  const saved = await store.set({ enabled: false });
  assert.equal(saved.enabled, false);
  assert.ok(saved.updatedAt);
  assert.equal(store.isEnabled(), false);

  const file = path.join(dir, MCP_ENDPOINT_FILE);
  assert.equal(store.file, file);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), saved);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.includes('.tmp-')), [], 'no temp file left behind');

  const again = createMcpEndpointStore(dir);
  assert.deepEqual(await again.load(), saved);
  assert.equal(again.isEnabled(), false);

  await again.set({ enabled: true });
  assert.equal((await createMcpEndpointStore(dir).load()).enabled, true);
});

test('unreadable or odd contents read as on; only false turns it off', async () => {
  const dir = await tempDir();
  const file = path.join(dir, MCP_ENDPOINT_FILE);
  await fs.writeFile(file, '{not json');
  assert.deepEqual(await quietly(() => createMcpEndpointStore(dir).load()), { enabled: true, updatedAt: null });
  for (const raw of ['null', '[]', '{}', '{"enabled":"false"}', '{"enabled":0}']) {
    await fs.writeFile(file, raw);
    assert.equal((await createMcpEndpointStore(dir).load()).enabled, true, raw);
  }
  await fs.writeFile(file, '{"enabled":false,"updatedAt":7}');
  assert.deepEqual(await createMcpEndpointStore(dir).load(), { enabled: false, updatedAt: null });
});

test('a bad change is refused with a plain reason and changes nothing', async () => {
  const store = createMcpEndpointStore(await tempDir());
  await store.load();
  for (const patch of [{}, { enabled: 'false' }, { enabled: 0 }, { enabled: null }, null, [true], 'off']) {
    await assert.rejects(
      () => store.set(patch),
      (err) => err instanceof McpEndpointError && err.status === 400 && err.message === 'enabled must be true or false.',
      JSON.stringify(patch)
    );
  }
  assert.deepEqual(store.get(), { enabled: true, updatedAt: null });
});

test('a save that fails keeps the previous setting', async () => {
  const base = await tempDir();
  const notADir = path.join(base, 'not-a-directory');
  await fs.writeFile(notADir, 'x');
  const store = createMcpEndpointStore(path.join(notADir, 'nested'));
  await quietly(() => store.load());
  await assert.rejects(() => store.set({ enabled: false }));
  assert.equal(store.isEnabled(), true);
});

test('changes made at once end with the last one saved', async () => {
  const dir = await tempDir();
  const store = createMcpEndpointStore(dir);
  await store.load();
  await Promise.all([false, true, false].map((enabled) => store.set({ enabled })));
  assert.equal(store.isEnabled(), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, MCP_ENDPOINT_FILE), 'utf8')).enabled, false);
});
