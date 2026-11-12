// Boots the real backend with its MCP server saved as off and checks /mcp and
// /api/mcp-endpoint as server.js wires them.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

const SERVER = fileURLToPath(new URL('./server.js', import.meta.url));
const TOKEN = 'test-token-mcp-endpoint-boot';
let child, baseUrl, dataDir;

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-mcp-endpoint-boot-'));
  await fs.writeFile(path.join(dataDir, 'mcp-endpoint.json'), JSON.stringify({ enabled: false, updatedAt: '2026-11-11T12:00:00.000Z' }));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      MIRABILIS_DATA_DIR: dataDir,
      MIRABILIS_MCP_TOKEN: TOKEN,
      // Nothing listens here, so no local engine is contacted.
      OLLAMA_BASE_URL: 'http://127.0.0.1:9',
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const deadline = Date.now() + 30000;
  for (;;) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('backend did not start');
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(async () => {
  child?.kill('SIGKILL');
  await fs.rm(dataDir, { recursive: true, force: true });
});

const auth = { Authorization: `Bearer ${TOKEN}` };
/** @param {Record<string, string>} [headers] */
const mcp = (headers = {}) => fetch(`${baseUrl}/mcp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
});
/** @param {unknown} enabled */
const setEnabled = (enabled) => fetch(`${baseUrl}/api/mcp-endpoint`, {
  method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled })
});

test('off from the saved file: /mcp answers 503 with or without the token', async () => {
  for (const headers of [{}, auth]) {
    const res = await mcp(headers);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'Mirabilis MCP server is off' });
  }
});

test('the switch needs the session token', async () => {
  assert.equal((await fetch(`${baseUrl}/api/mcp-endpoint`)).status, 401);
  const unauth = await fetch(`${baseUrl}/api/mcp-endpoint`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' });
  assert.equal(unauth.status, 401);
  const body = await (await fetch(`${baseUrl}/api/mcp-endpoint`, { headers: auth })).json();
  assert.equal(body.enabled, false);
  assert.equal(body.path, '/mcp');
  assert.ok(body.tools.includes('run_command'), body.tools.join(','));
});

test('switched on: /mcp wants the token again and answers MCP; off again is 503', async () => {
  const res = await setEnabled(true);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).enabled, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'mcp-endpoint.json'), 'utf8')).enabled, true);
  assert.equal((await mcp()).status, 401);
  const ok = await mcp(auth);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.serverInfo.name, 'mirabilis');

  assert.equal((await setEnabled(false)).status, 200);
  assert.equal((await mcp(auth)).status, 503);
  assert.equal((await setEnabled('yes')).status, 400);
});
