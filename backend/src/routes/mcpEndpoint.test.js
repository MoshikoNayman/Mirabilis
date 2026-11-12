// /api/mcp-endpoint and the /mcp gate on a bare express app: the guard, the shape,
// a saved change, and a switched-off server answering 503 before any token check.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createMcpEndpointRouter, makeMcpEndpointGate, MCP_OFF_ERROR } from './mcpEndpoint.js';
import { createMcpEndpointStore } from '../mcpEndpoint.js';
import { MCP_TOOL_NAMES } from '../mcp/mcpServer.js';
import { makeMcpAuthGuard, makePrivilegedGuard } from '../security.js';

const TOKEN = 'test-token-mcp-endpoint';
const servers = [];

async function serve() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-mcp-endpoint-route-'));
  const store = createMcpEndpointStore(dataDir);
  await store.load();
  let calls = 0;
  const app = express();
  app.use('/api/mcp-endpoint', createMcpEndpointRouter({ store, guard: makePrivilegedGuard(TOKEN, 'MCP server') }));
  // Same chain as server.js: the switch, then the token, then the MCP handler.
  app.post('/mcp', makeMcpEndpointGate(store), makeMcpAuthGuard(TOKEN), express.json(), (_req, res) => {
    calls += 1;
    res.json({ jsonrpc: '2.0', id: 1, result: {} });
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, url: `${base}/api/mcp-endpoint`, dataDir, store, calls: () => calls };
}

after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

const auth = { Authorization: `Bearer ${TOKEN}` };
const put = (url, body, raw) => fetch(url, {
  method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: raw ?? JSON.stringify(body)
});
/** @param {string} base @param {Record<string, string>} [headers] */
const callMcp = (base, headers = {}) => fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
});

test('without the session token every call is refused', async () => {
  const { url, store } = await serve();
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false}' })).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal(store.isEnabled(), true, 'nothing changed');
});

test('GET answers with the switch, the path and the tool names', async () => {
  const { url } = await serve();
  const res = await fetch(url, { headers: auth });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { enabled: true, path: '/mcp', tools: [...MCP_TOOL_NAMES] });
  assert.deepEqual(body.tools, ['mirabilis_chat', 'mirabilis_list_models', 'mirabilis_health', 'system_info', 'list_dir', 'read_file', 'write_file', 'run_command']);
});

test('PUT saves the switch and answers in the GET shape', async () => {
  const { url, dataDir } = await serve();
  const res = await put(url, { enabled: false });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { enabled: false, path: '/mcp', tools: [...MCP_TOOL_NAMES] });
  const file = path.join(dataDir, 'mcp-endpoint.json');
  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(onDisk.enabled, false);
  assert.equal(typeof onDisk.updatedAt, 'string');
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await (await fetch(url, { headers: auth })).json()).enabled, false);
  assert.equal((await (await put(url, { enabled: true })).json()).enabled, true);
});

test('a body without a boolean enabled is a 400 and changes nothing', async () => {
  const { url, store } = await serve();
  for (const body of [{}, { enabled: 'false' }, { enabled: 0 }, { enabled: null }, [false]]) {
    const res = await put(url, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error, 'enabled must be true or false.');
  }
  const malformed = await put(url, null, '{"enabled":');
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /not valid JSON/);
  assert.equal(store.isEnabled(), true);
});

test('switched off, /mcp answers 503 before the token is checked', async () => {
  const { base, url, calls } = await serve();
  assert.equal((await callMcp(base)).status, 401, 'on: no token, no entry');
  assert.equal((await callMcp(base, auth)).status, 200);
  assert.equal(calls(), 1);

  await put(url, { enabled: false });
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, auth]) {
    const res = await callMcp(base, headers);
    assert.equal(res.status, 503, JSON.stringify(headers));
    assert.deepEqual(await res.json(), { error: MCP_OFF_ERROR });
  }
  assert.equal(MCP_OFF_ERROR, 'Mirabilis MCP server is off');
  assert.equal(calls(), 1, 'the handler never ran while off');

  await put(url, { enabled: true });
  assert.equal((await callMcp(base)).status, 401);
  assert.equal((await callMcp(base, auth)).status, 200);
  assert.equal(calls(), 2);
});

test('the router refuses to mount without a guard', () => {
  assert.throws(() => createMcpEndpointRouter({ store: createMcpEndpointStore(os.tmpdir()), guard: undefined }), /privileged guard/);
});
