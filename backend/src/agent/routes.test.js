// Route-level tests for autonomous runs, against the real server process.
//
// The bug these exist for: a run started from the UI with the model picker on
// "Auto" sends no model at all, and the route passed that undefined straight to
// the provider. Every such run died instantly on "model is required" while the
// panel just said the run failed to start.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'fs/promises';
import os from 'os';

const SERVER_ENTRY = fileURLToPath(new URL('../server.js', import.meta.url));
const ndjson = (o) => JSON.stringify(o) + '\n';

async function freePort() {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = /** @type {any} */ (srv.address());
  await new Promise((r) => srv.close(r));
  return port;
}

/** Fake Ollama that records the model each request asked for. */
let engine, engineUrl;
const seenModels = [];
let replyIndex = 0;
const REPLIES = [
  'Plan: answer from knowledge.',
  '{"action":"finish","summary":"A 20,000 mAh pack with 65W USB-C PD."}',
  '{"pass": true, "reason": "answers the question"}'
];

async function startEngine() {
  engine = http.createServer((req, res) => {
    if (req.url.startsWith('/api/tags')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ models: [{ name: 'installed-model:latest', model: 'installed-model:latest', size: 1e9 }] }));
    }
    if (req.url.startsWith('/api/show')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ model_info: { 'general.context_length': 8192 }, capabilities: ['completion'] }));
    }
    if (req.url.startsWith('/api/chat')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { seenModels.push(JSON.parse(body).model); } catch { seenModels.push(null); }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(ndjson({ message: { content: REPLIES[Math.min(replyIndex++, REPLIES.length - 1)] } }));
        res.end(ndjson({ done: true, eval_count: 10 }));
      });
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => engine.listen(0, '127.0.0.1', r));
  const { port } = /** @type {any} */ (engine.address());
  engineUrl = `http://127.0.0.1:${port}`;
}

let child, baseUrl, dataDir, token;

before(async () => {
  await startEngine();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-agent-routes-'));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(port), MIRABILIS_DATA_DIR: dataDir, OLLAMA_BASE_URL: engineUrl, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const deadline = Date.now() + 30000;
  for (;;) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('backend did not start');
    await new Promise((r) => setTimeout(r, 150));
  }
  token = (await (await fetch(`${baseUrl}/api/session/token`)).json()).token;
});

after(async () => {
  if (child) child.kill('SIGKILL');
  if (engine) await new Promise((r) => engine.close(r));
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

async function startRun(body) {
  const res = await fetch(`${baseUrl}/api/agent/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mirabilis-mcp-token': token },
    body: JSON.stringify(body)
  });
  const raw = await res.text();
  const frames = [];
  let ev = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) ev = line.slice(7).trim();
    else if (line.startsWith('data: ')) {
      try { frames.push({ event: ev, data: JSON.parse(line.slice(6)) }); } catch { /* skip */ }
    }
  }
  return { status: res.status, frames };
}

test('a run with NO model resolves one instead of dying on "model is required"', async () => {
  replyIndex = 0; seenModels.length = 0;
  const { frames } = await startRun({
    goal: 'testing how smart you are. what best phone battery pack you recommend?',
    effort: 'high',
    provider: 'ollama'
    // no model: this is what the picker sends on "Auto"
  });

  const errors = frames.filter((f) => f.data?.type === 'run-error' || f.event === 'error');
  assert.deepEqual(errors.map((e) => e.data.error), [], 'the run must not fail to start');

  const resolved = frames.find((f) => f.data?.type === 'model-resolved');
  assert.ok(resolved, 'the route should announce the model it resolved');
  assert.ok(resolved.data.model, 'a concrete model id must be chosen');

  assert.ok(seenModels.length > 0, 'the engine should have been called');
  for (const m of seenModels) {
    assert.ok(m, 'every upstream call must carry a real model, never undefined');
  }

  const result = frames.find((f) => f.event === 'result');
  assert.equal(result.data.ok, true);
  assert.match(result.data.answer, /mAh|battery|pack/i);
});

test('a knowledge question needs no tools and still completes', async () => {
  replyIndex = 0; seenModels.length = 0;
  const { frames } = await startRun({
    goal: 'what is the best phone battery pack?', effort: 'high', provider: 'ollama'
  });
  const result = frames.find((f) => f.event === 'result').data;
  assert.equal(result.ok, true);
  assert.equal(result.budget.toolCalls, 0, 'answering from knowledge should spend no tool budget');
  assert.equal(result.validated, true);
});

test('an explicit model is passed through unchanged', async () => {
  replyIndex = 0; seenModels.length = 0;
  await startRun({ goal: 'x', effort: 'high', provider: 'ollama', model: 'installed-model:latest' });
  assert.ok(seenModels.every((m) => m === 'installed-model:latest'));
});

test('an unreachable engine reports how to fix it, not "fetch failed"', async () => {
  const { frames } = await startRun({
    goal: 'x', effort: 'high', provider: 'openai-compatible',
    providerBaseUrl: 'http://127.0.0.1:1/v1', model: 'whatever'
  });
  const err = frames.find((f) => f.data?.type === 'run-error' || f.event === 'error');
  assert.ok(err, 'an unreachable engine should surface an error');
  assert.match(err.data.error, /Could not reach/, 'the message must say what went wrong');
  assert.match(err.data.error, /ollama serve|running/i, 'and what to do about it');
});

// ── persisting the run into a chat ──────────────────────────────────────────
// The client used to POST the goal and answer to /api/chats/:id/messages, a
// route that does not exist, so the result lived only in the run panel and was
// lost the moment it closed.

async function newChat() {
  const res = await fetch(`${baseUrl}/api/chats`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  return (await res.json()).chat.id;
}
const readChat = async (id) => (await (await fetch(`${baseUrl}/api/chats/${id}`)).json()).chat;

test('a run writes its goal and result into the chat it was given', async () => {
  replyIndex = 0;
  const chatId = await newChat();
  const { frames } = await startRun({
    goal: 'what best phone battery pack you recommend?',
    effort: 'high', provider: 'ollama', chatId
  });

  const result = frames.find((f) => f.event === 'result').data;
  assert.equal(result.persistedTo, chatId, 'the run should report where it saved');

  const chat = await readChat(chatId);
  assert.deepEqual(chat.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(chat.messages[0].content, 'what best phone battery pack you recommend?');
  assert.match(chat.messages[1].content, /mAh|battery|pack/i);

  const meta = chat.messages[1].agentRun;
  assert.ok(meta, 'the assistant turn should record that it came from a run');
  assert.equal(meta.effort, 'high');
  assert.equal(meta.stopReason, 'completed');
  assert.equal(meta.validated, true);
});

test('a run with no chatId still succeeds and reports nothing persisted', async () => {
  replyIndex = 0;
  const { frames } = await startRun({ goal: 'no chat', effort: 'high', provider: 'ollama' });
  const result = frames.find((f) => f.event === 'result').data;
  assert.equal(result.ok, true);
  assert.equal(result.persistedTo, null);
});

test('an unknown chatId does not fail the run', async () => {
  replyIndex = 0;
  const { frames } = await startRun({
    goal: 'ghost chat', effort: 'high', provider: 'ollama',
    chatId: '00000000-0000-0000-0000-000000000000'
  });
  const result = frames.find((f) => f.event === 'result').data;
  assert.equal(result.ok, true, 'the work is done; a persistence miss must not undo it');
  assert.equal(result.persistedTo, null);
});

test('a stopped run still persists the partial work it managed', async () => {
  replyIndex = 0;
  const chatId = await newChat();
  const { frames } = await startRun({
    goal: 'give up early', effort: 'high', provider: 'ollama', chatId,
    overrides: { maxIterations: 1, validate: false }
  });
  const result = frames.find((f) => f.event === 'result').data;
  const chat = await readChat(chatId);
  assert.equal(chat.messages.length, 2, 'the goal and whatever came of it should both be recorded');
  assert.equal(chat.messages[1].agentRun.stopReason, result.stopReason);
});

// ── the full tool policy needs an explicit decision ─────────────────────────

test('the full policy is refused without an explicit acknowledgement', async () => {
  // Granting a background process a shell must never be reachable by a default
  // or a remembered setting.
  const res = await fetch(`${baseUrl}/api/agent/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mirabilis-mcp-token': token },
    body: JSON.stringify({ goal: 'x', effort: 'high', provider: 'ollama', toolPolicy: 'full' })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.requiresAcknowledgement, 'full-policy');
  assert.match(body.error, /shell commands/i, 'the refusal must say what is being granted');
});

test('the full policy runs once acknowledged', async () => {
  replyIndex = 0;
  const { frames } = await startRun({
    goal: 'x', effort: 'high', provider: 'ollama',
    toolPolicy: 'full', acknowledgeFullPolicy: true
  });
  const result = frames.find((f) => f.event === 'result');
  assert.ok(result, 'an acknowledged run should proceed');
  assert.equal(result.data.ok, true);
});

test('read-only and write need no acknowledgement', async () => {
  for (const policy of ['read-only', 'write']) {
    replyIndex = 0;
    const { frames } = await startRun({ goal: 'x', effort: 'high', provider: 'ollama', toolPolicy: policy });
    assert.ok(frames.find((f) => f.event === 'result'), `${policy} should not be gated`);
  }
});
