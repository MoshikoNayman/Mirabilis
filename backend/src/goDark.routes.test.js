// Boots the real backend with Go Dark on and checks the routes refuse to leave the machine.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

const SERVER = fileURLToPath(new URL('./server.js', import.meta.url));
let child, baseUrl, dataDir, engine, engineUrl;

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

before(async () => {
  engine = http.createServer((req, res) => {
    if (req.url.startsWith('/api/tags')) return res.end(JSON.stringify({ models: [{ name: 'fake:latest' }] }));
    if (req.url.startsWith('/api/show')) return res.end(JSON.stringify({ model_info: {}, capabilities: ['completion'] }));
    if (req.url.startsWith('/api/chat')) {
      res.write(JSON.stringify({ message: { content: 'local reply' } }) + '\n');
      return res.end(JSON.stringify({ done: true }) + '\n');
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => engine.listen(0, '127.0.0.1', r));
  engineUrl = `http://127.0.0.1:${engine.address().port}`;

  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-godark-'));
  await fs.writeFile(path.join(dataDir, 'go-dark.json'), JSON.stringify({ on: true }));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), MIRABILIS_DATA_DIR: dataDir, OLLAMA_BASE_URL: engineUrl, NODE_ENV: 'test' },
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
  await new Promise((r) => engine.close(r));
  await fs.rm(dataDir, { recursive: true, force: true });
});

const newChat = async () => (await (await fetch(`${baseUrl}/api/chats`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).chat.id;

test('the backend reports the persisted state', async () => {
  assert.deepEqual(await (await fetch(`${baseUrl}/api/go-dark`)).json(), { on: true });
});

test('a local model still works', async () => {
  const id = await newChat();
  const res = await fetch(`${baseUrl}/api/chats/${id}/messages/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hi', provider: 'ollama', model: 'fake:latest' })
  });
  assert.match(await res.text(), /local reply/);
});

test('a cloud provider is refused even when the client forgets to say Go Dark', async () => {
  const id = await newChat();
  const res = await fetch(`${baseUrl}/api/chats/${id}/messages/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hi', provider: 'openai', model: 'gpt-x' })
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Go Dark/);
});

test('health checks report cloud providers as dark without contacting them', async () => {
  const data = await (await fetch(`${baseUrl}/api/providers/health?provider=openai`, { headers: { 'x-provider-key': 'sk-test' } })).json();
  assert.equal(data.dark, true);
});

test('model downloads and web search are refused', async () => {
  const pull = await fetch(`${baseUrl}/api/models/install-jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId: 'qwen3' }) });
  assert.equal(pull.status, 403);
  const search = await fetch(`${baseUrl}/api/web-search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'x' }) });
  assert.equal(search.status, 403);
});

test('turning it off is persisted', async () => {
  await fetch(`${baseUrl}/api/go-dark`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) });
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'go-dark.json'), 'utf8')).on, false);
  await fetch(`${baseUrl}/api/go-dark`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) });
});
