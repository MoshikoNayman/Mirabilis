// Route-level tests for the chat SSE stream and the guards around it.
//
// server.js registers 88 routes and had zero tests. The chat stream is the one
// that matters most: it is the app's core path, it emits five different SSE
// event types, and three separate defects lived in it (a mid-stream error saved
// as an empty successful reply, a compression filter that gzipped the stream,
// and a Go Dark check that trusted the provider ID).
//
// These boot the REAL backend as a child process against a fake upstream engine,
// rather than importing the express app. That keeps server.js free of a
// test-only export path and exercises the actual middleware stack, including
// compression, which is exactly where one of the bugs lived.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'fs/promises';
import os from 'os';

const SERVER_ENTRY = fileURLToPath(new URL('./server.js', import.meta.url));

/** Reserve a free port by binding and immediately releasing it. */
async function freePort() {
  const srv = http.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

const ndjson = (obj) => JSON.stringify(obj) + '\n';

/** Fake Ollama. `mode` decides how /api/chat behaves for the next call. */
let engineMode = 'ok';
let engine, engineUrl;

async function startEngine() {
  engine = http.createServer((req, res) => {
    if (req.url.startsWith('/api/tags')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ models: [{ name: 'fake:latest', model: 'fake:latest' }] }));
    }
    if (req.url.startsWith('/api/show')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ model_info: { 'general.context_length': 8192 }, capabilities: ['completion'] }));
    }
    if (req.url.startsWith('/api/chat')) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      if (engineMode === 'mid-stream-error') {
        res.write(ndjson({ message: { content: 'partial' } }));
        return res.end(ndjson({ error: 'model runner has unexpectedly stopped' }));
      }
      if (engineMode === 'slow') {
        // Emit slowly so the test can disconnect mid-reply.
        let n = 0;
        const timer = setInterval(() => {
          if (n >= 20 || res.writableEnded) { clearInterval(timer); try { res.end(); } catch {} return; }
          res.write(ndjson({ message: { content: `chunk${n++} ` } }));
        }, 60);
        req.on('close', () => clearInterval(timer));
        return;
      }
      if (engineMode === 'empty') {
        // 200 with no content at all, then a clean done.
        return res.end(ndjson({ done: true }));
      }
      res.write(ndjson({ message: { content: 'Hello' } }));
      res.write(ndjson({ message: { content: ' there' } }));
      // A long-ish reply so compression would have something to act on.
      res.write(ndjson({ message: { content: ' ' + 'x'.repeat(2000) } }));
      return res.end(ndjson({ done: true, eval_count: 3, eval_duration: 1e9 }));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((resolve) => engine.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (engine.address());
  engineUrl = `http://127.0.0.1:${port}`;
}

let child, baseUrl, dataDir;

before(async () => {
  await startEngine();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-stream-test-'));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      MIRABILIS_DATA_DIR: dataDir,
      OLLAMA_BASE_URL: engineUrl,
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  // Drain so the child never blocks on a full pipe.
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  // Wait for readiness rather than sleeping a fixed amount.
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('backend did not become healthy');
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(async () => {
  if (child) child.kill('SIGKILL');
  if (engine) await new Promise((resolve) => engine.close(resolve));
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

/** Parse a raw SSE body into [{ event, data }]. */
function parseSSE(raw) {
  const frames = [];
  for (const block of raw.split('\n\n')) {
    const eventLine = block.match(/^event: (.+)$/m);
    const dataLine = block.match(/^data: (.+)$/m);
    if (!dataLine) continue;
    let data;
    try { data = JSON.parse(dataLine[1]); } catch { data = dataLine[1]; }
    frames.push({ event: eventLine ? eventLine[1] : 'message', data });
  }
  return frames;
}

const newChat = async () => {
  const res = await fetch(`${baseUrl}/api/chats`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  return (await res.json()).chat.id;
};

const send = (chatId, body) => fetch(`${baseUrl}/api/chats/${chatId}/messages/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip, deflate' },
  body: JSON.stringify({ content: 'hi', provider: 'ollama', model: 'fake:latest', ...body })
});

const getChat = async (chatId) => (await (await fetch(`${baseUrl}/api/chats/${chatId}`)).json()).chat;

// ── happy path ───────────────────────────────────────────────────────────────

test('a successful stream emits meta, then tokens, then done, in that order', async () => {
  engineMode = 'ok';
  const chatId = await newChat();
  const res = await send(chatId);
  assert.equal(res.status, 200);

  const frames = parseSSE(await res.text());
  const events = frames.map((f) => f.event);

  assert.ok(events.includes('meta'), 'should announce provider/model up front');
  assert.ok(events.includes('token'), 'should stream tokens');
  assert.ok(events.includes('done'), 'should finish with done');
  assert.ok(events.indexOf('meta') < events.indexOf('token'), 'meta must precede tokens');
  assert.ok(events.indexOf('token') < events.indexOf('done'), 'tokens must precede done');
  assert.ok(!events.includes('error'), 'a healthy stream must not emit error');

  const text = frames.filter((f) => f.event === 'token').map((f) => f.data.token).join('');
  assert.ok(text.startsWith('Hello there'), `unexpected reply: ${text.slice(0, 40)}`);
});

test('the SSE response is never gzipped', async () => {
  // The compression filter tested the REQUEST Accept header, but the chat client
  // is a fetch POST that sends Content-Type only, so Accept is */* and the guard
  // never fired. text/event-stream is `compressible`, so the stream was being
  // buffered by gzip and tokens stalled.
  engineMode = 'ok';
  const chatId = await newChat();
  const res = await send(chatId);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(
    res.headers.get('content-encoding'), null,
    'SSE must not be compressed, or token delivery stalls until the gzip buffer flushes'
  );
  await res.text();
});

test('a successful reply is persisted with its performance receipt', async () => {
  engineMode = 'ok';
  const chatId = await newChat();
  await (await send(chatId)).text();

  const chat = await getChat(chatId);
  const roles = chat.messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant']);
  const reply = chat.messages[1];
  assert.ok(reply.content.startsWith('Hello there'));
  assert.equal(reply.performance?.source, 'ollama', 'exact engine metrics should be recorded');
});

// ── failure paths: the defects that shipped ─────────────────────────────────

test('a mid-stream engine error emits an error event and persists NOTHING', async () => {
  engineMode = 'mid-stream-error';
  const chatId = await newChat();
  const frames = parseSSE(await (await send(chatId)).text());

  const err = frames.find((f) => f.event === 'error');
  assert.ok(err, 'a mid-stream failure must surface as an error event');
  assert.match(String(err.data.error), /unexpectedly stopped/, 'the real engine message should reach the user');
  assert.ok(!frames.some((f) => f.event === 'done'), 'a failed stream must not report done');

  const chat = await getChat(chatId);
  assert.equal(
    chat.messages.filter((m) => m.role === 'assistant').length, 0,
    'a failed generation must not be saved as an assistant turn'
  );
});

test('an engine that returns no text at all is treated as a failure', async () => {
  engineMode = 'empty';
  const chatId = await newChat();
  const frames = parseSSE(await (await send(chatId)).text());

  assert.ok(frames.some((f) => f.event === 'error'), 'an empty reply is a failure, not an empty answer');
  const chat = await getChat(chatId);
  assert.equal(chat.messages.filter((m) => m.role === 'assistant').length, 0);
});

test('the user message is preserved when generation fails, so the text is not lost', async () => {
  engineMode = 'mid-stream-error';
  const chatId = await newChat();
  await (await send(chatId)).text();
  const chat = await getChat(chatId);
  assert.equal(chat.messages[0]?.role, 'user');
  assert.equal(chat.messages[0]?.content, 'hi');
});

// ── validation and guards ───────────────────────────────────────────────────

test('a missing content field is rejected with 400', async () => {
  const chatId = await newChat();
  const res = await fetch(`${baseUrl}/api/chats/${chatId}/messages/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'ollama' })
  });
  assert.equal(res.status, 400);
});

test('an unknown chat id is rejected rather than creating one', async () => {
  const res = await send('00000000-0000-0000-0000-000000000000');
  assert.ok(res.status >= 400, `expected an error status, got ${res.status}`);
  await res.text();
});

test('Go Dark blocks a cloud provider at the route', async () => {
  const chatId = await newChat();
  const res = await send(chatId, { provider: 'openai', localOnly: true });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Go Dark/);
});

test('Go Dark blocks a base-URL provider pointed off-device', async () => {
  // The original hole: vllm/llamacpp/openai-compatible were not in the remote
  // set, so Go Dark waved them through no matter where they pointed.
  const chatId = await newChat();
  const res = await send(chatId, {
    provider: 'vllm', providerBaseUrl: 'https://api.example-cloud.com/v1', localOnly: true
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /not on this machine/);
});

test('Go Dark allows a base-URL provider pointed at loopback', async () => {
  const chatId = await newChat();
  const res = await send(chatId, {
    provider: 'vllm', providerBaseUrl: 'http://127.0.0.1:9/v1', localOnly: true
  });
  assert.notEqual(res.status, 403, 'a genuinely local endpoint must stay usable under Go Dark');
  await res.text();
});

test('privileged routes require the session token', async () => {
  const res = await fetch(`${baseUrl}/api/remote/exec`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'id' })
  });
  assert.equal(res.status, 401, 'shell execution over SSH must not be reachable unauthenticated');
});

test('the session token bootstrap works and unlocks the privileged routes', async () => {
  const { token } = await (await fetch(`${baseUrl}/api/session/token`)).json();
  assert.ok(token && token.length > 16, 'a usable token should be issued to a loopback caller');

  const res = await fetch(`${baseUrl}/api/remote/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mirabilis-mcp-token': token },
    body: JSON.stringify({ command: 'id' })
  });
  assert.notEqual(res.status, 401, 'a valid token must pass the guard');
  await res.text();
});

// ── clear-all: the privacy path ─────────────────────────────────────────────

test('DELETE /api/chats clears every chat and leaves no backup behind', async () => {
  engineMode = 'ok';
  const chatId = await newChat();
  await (await send(chatId)).text();
  assert.ok((await (await fetch(`${baseUrl}/api/chats`)).json()).chats.length > 0);

  const res = await fetch(`${baseUrl}/api/chats`, { method: 'DELETE' });
  assert.equal(res.status, 204);

  assert.equal((await (await fetch(`${baseUrl}/api/chats`)).json()).chats.length, 0);
  await assert.rejects(
    () => fs.readFile(path.join(dataDir, 'chats.json.bak'), 'utf8'),
    /ENOENT/,
    'clear-all must not leave the pre-delete store in a sibling .bak file'
  );
});

// ── client disconnect ───────────────────────────────────────────────────────

test('a client that disconnects mid-stream keeps its partial reply, marked truncated', async () => {
  // The provider adapters swallow AbortError and return normally, so without an
  // explicit flag the route cannot tell a finished reply from an abandoned one
  // and would save half an answer as though it were whole.
  engineMode = 'slow';
  const chatId = await newChat();

  const controller = new AbortController();
  const pending = fetch(`${baseUrl}/api/chats/${chatId}/messages/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hi', provider: 'ollama', model: 'fake:latest' }),
    signal: controller.signal
  }).catch(() => null);

  // Let a couple of tokens land, then walk away.
  await new Promise((r) => setTimeout(r, 260));
  controller.abort();
  await pending;
  await new Promise((r) => setTimeout(r, 400)); // let the server finish its bookkeeping

  const chat = await getChat(chatId);
  const replies = chat.messages.filter((m) => m.role === 'assistant');
  assert.equal(replies.length, 1, 'the partial reply should be kept, not discarded');
  assert.ok(replies[0].content.length > 0, 'it should contain the tokens that were produced');
  assert.equal(replies[0].truncated, true, 'it must be flagged as cut short');
  assert.equal(replies[0].stopReason, 'client-disconnect');
});
