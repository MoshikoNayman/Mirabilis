// Route-level tests for agent runs against the real server process: Access levels,
// the approval flow over SSE, and persisting a run into its chat.

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

/**
 * Fake Ollama. `script` picks each reply from the prompt; without one it replays
 * REPLIES in order. Records the model and the prompt of every call.
 */
let engine, engineUrl;
const seenModels = [];
const seenPrompts = [];
let replyIndex = 0;
/** @type {null | ((p: {system: string, user: string}) => string)} */
let script = null;
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
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* recorded as empty */ }
        seenModels.push(parsed.model ?? null);
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        const prompt = {
          system: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
          user: messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n')
        };
        seenPrompts.push(prompt);
        const text = script ? script(prompt) : REPLIES[Math.min(replyIndex++, REPLIES.length - 1)];
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(ndjson({ message: { content: text } }));
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

let child, baseUrl, dataDir, token, projDir;

before(async () => {
  await startEngine();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-agent-routes-'));
  projDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-agent-project-'));
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
  for (const dir of [dataDir, projDir]) if (dir) await fs.rm(dir, { recursive: true, force: true });
});

const authJson = () => ({ 'Content-Type': 'application/json', 'x-mirabilis-mcp-token': token });

async function setAccess(patch) {
  const res = await fetch(`${baseUrl}/api/access`, { method: 'PUT', headers: authJson(), body: JSON.stringify(patch) });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}

/**
 * Start a run and read its SSE stream as it arrives. `onFrame` may act mid-run,
 * for example answer an approval.
 */
async function runStream(body, onFrame = async () => {}) {
  const res = await fetch(`${baseUrl}/api/agent/runs`, { method: 'POST', headers: authJson(), body: JSON.stringify(body) });
  if (!res.ok || !res.body) return { status: res.status, body: await res.json().catch(() => null), frames: [], runId: null };
  const frames = [];
  let runId = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      if (event === 'run-accepted') runId = parsed.id;
      const frame = { event, data: parsed };
      frames.push(frame);
      await onFrame(frame, runId);
    }
    if (done) break;
  }
  return { status: res.status, frames, runId };
}

const startRun = (body) => runStream(body);
const progress = (frames, type) => frames.filter((f) => f.event === 'progress' && f.data?.type === type).map((f) => f.data);
const resultOf = (frames) => frames.find((f) => f.event === 'result')?.data;
const exists = (p) => fs.stat(p).then(() => true, () => false);

/** Reply with each step in turn, one per tool result seen so far, then finish. */
function steps(actions, summary = 'done') {
  return ({ user }) => {
    const done = (user.match(/\n {2}observed: /g) || []).length;
    if (done < actions.length) return JSON.stringify({ action: 'tool', ...actions[done] });
    return JSON.stringify({ action: 'finish', summary });
  };
}

function answer(runId, approvalId, decision, note) {
  return fetch(`${baseUrl}/api/agent/runs/${runId}/approvals/${approvalId}`, {
    method: 'POST', headers: authJson(), body: JSON.stringify({ decision, ...(note ? { note } : {}) })
  });
}

// the basics, at the default Chat only level

test('a run with NO model resolves one instead of dying on "model is required"', async () => {
  replyIndex = 0; seenModels.length = 0; script = null;
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

  const result = resultOf(frames);
  assert.equal(result.ok, true);
  assert.match(result.answer, /mAh|battery|pack/i);
});

test('a knowledge question needs no tools and still completes', async () => {
  replyIndex = 0; seenModels.length = 0; script = null;
  const { frames } = await startRun({ goal: 'what is the best phone battery pack?', effort: 'high', provider: 'ollama' });
  const result = resultOf(frames);
  assert.equal(result.ok, true);
  assert.equal(result.budget.toolCalls, 0, 'answering from knowledge should spend no tool budget');
  assert.equal(result.validated, true);
});

test('an explicit model is passed through unchanged', async () => {
  replyIndex = 0; seenModels.length = 0; script = null;
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

// persisting the run into a chat

async function newChat() {
  const res = await fetch(`${baseUrl}/api/chats`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  return (await res.json()).chat.id;
}
const readChat = async (id) => (await (await fetch(`${baseUrl}/api/chats/${id}`)).json()).chat;

test('a run writes its goal and result into the chat it was given', async () => {
  replyIndex = 0; script = null;
  const chatId = await newChat();
  const { frames } = await startRun({
    goal: 'what best phone battery pack you recommend?',
    effort: 'high', provider: 'ollama', chatId
  });

  const result = resultOf(frames);
  assert.equal(result.persistedTo, chatId, 'the run should report where it saved');

  const chat = await readChat(chatId);
  assert.deepEqual(chat.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(chat.messages[0].content, 'what best phone battery pack you recommend?');
  assert.match(chat.messages[1].content, /mAh|battery|pack/i);

  const meta = chat.messages[1].agentRun;
  assert.ok(meta, 'the assistant turn should record that it came from a run');
  assert.equal(meta.effort, 'high');
  assert.equal(meta.access, 'chat');
  assert.equal(meta.stopReason, 'completed');
  assert.equal(meta.validated, true);
});

test('a run with no chatId still succeeds and reports nothing persisted', async () => {
  replyIndex = 0; script = null;
  const { frames } = await startRun({ goal: 'no chat', effort: 'high', provider: 'ollama' });
  const result = resultOf(frames);
  assert.equal(result.ok, true);
  assert.equal(result.persistedTo, null);
});

test('an unknown chatId does not fail the run', async () => {
  replyIndex = 0; script = null;
  const { frames } = await startRun({
    goal: 'ghost chat', effort: 'high', provider: 'ollama',
    chatId: '00000000-0000-0000-0000-000000000000'
  });
  const result = resultOf(frames);
  assert.equal(result.ok, true, 'the work is done; a persistence miss must not undo it');
  assert.equal(result.persistedTo, null);
});

test('a stopped run still persists the partial work it managed', async () => {
  replyIndex = 0; script = null;
  const chatId = await newChat();
  const { frames } = await startRun({
    goal: 'give up early', effort: 'high', provider: 'ollama', chatId,
    overrides: { maxIterations: 1, validate: false }
  });
  const result = resultOf(frames);
  const chat = await readChat(chatId);
  assert.equal(chat.messages.length, 2, 'the goal and whatever came of it should both be recorded');
  assert.equal(chat.messages[1].agentRun.stopReason, result.stopReason);
});

// Access

test('Access and Connectors refuse a caller without the session token', async () => {
  for (const route of ['/api/access', '/api/connectors', '/api/connectors/catalog']) {
    const res = await fetch(`${baseUrl}${route}`);
    assert.equal(res.status, 401, route);
  }
  const put = await fetch(`${baseUrl}/api/access`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'bypass' })
  });
  assert.equal(put.status, 401, 'raising Access needs the token');
  const access = await (await fetch(`${baseUrl}/api/access`, { headers: authJson() })).json();
  assert.equal(access.level, 'chat', 'the default is Chat only');
  const connectors = await (await fetch(`${baseUrl}/api/connectors`, { headers: authJson() })).json();
  assert.deepEqual(connectors.connectors, []);
});

test('Chat only with a single-shot effort is sent back to the chat route', async () => {
  await setAccess({ level: 'chat' });
  const first = await runStream({ goal: 'hi', effort: 'balanced', provider: 'ollama' });
  assert.equal(first.status, 400);
  assert.equal(first.body.useChat, true);
  assert.equal(first.body.error, 'Chat only: send this as a normal chat message, or change Access.');

  await setAccess({ level: 'bypass' });
  const lowered = await runStream({ goal: 'hi', effort: 'fast', access: 'chat', provider: 'ollama' });
  assert.equal(lowered.status, 400, 'a request that lowers to Chat only is refused the same way');
  assert.equal(lowered.body.useChat, true);
  await setAccess({ level: 'chat' });
});

test('a request can lower the saved level but never raise it', async () => {
  script = () => '{"action":"finish","summary":"ok"}';
  await setAccess({ level: 'read' });
  const accessOf = async (extra) => {
    const { frames } = await runStream({ goal: 'level probe', effort: 'high', provider: 'ollama', overrides: { plan: false, validate: false }, ...extra });
    return frames.find((f) => f.event === 'run-accepted').data.access;
  };
  assert.equal(await accessOf({}), 'read');
  assert.equal(await accessOf({ access: 'bypass' }), 'read', 'a request cannot raise the level');
  assert.equal(await accessOf({ access: 'ask' }), 'read');
  assert.equal(await accessOf({ access: 'chat' }), 'chat');
  assert.equal(await accessOf({ access: 'superuser' }), 'chat', 'an unknown level counts as Chat only');
  script = null;
  await setAccess({ level: 'chat' });
});

test('a single-shot effort with tools on runs the short assist loop, told where it is', async () => {
  await setAccess({ level: 'read' });
  seenPrompts.length = 0;
  script = () => '{"action":"finish","summary":"assisted"}';
  const { frames } = await runStream({ goal: 'what is using my CPU?', effort: 'fast', provider: 'ollama', fsRoot: projDir });
  const accepted = frames.find((f) => f.event === 'run-accepted').data;
  assert.equal(accepted.effort, 'assist');
  assert.equal(accepted.access, 'read');
  assert.equal(accepted.limits.maxIterations, 16);
  assert.equal(accepted.limits.maxToolCalls, 40);
  assert.equal(accepted.limits.maxWallMs, 10 * 60_000);
  assert.equal(accepted.limits.plan, false);
  assert.equal(accepted.limits.validate, false);
  assert.equal(resultOf(frames).answer, 'assisted');

  const system = seenPrompts[0].system;
  assert.match(system, /^You are Mirabilis, an assistant running on this computer: .+ \(.+\), user .+, home .+, shell .+\./);
  assert.match(system, /Access: Read only\./);
  assert.match(system, /Your own source code is at .+\. For questions about how Mirabilis works, call mirabilis_architecture first/);
  assert.ok(system.includes(`Project folder: ${projDir}.`), system);
  assert.match(system, /You cannot change anything; when a fix needs a change, give the exact command or edit/);
  assert.match(system, /Effort: fast\./, 'the chosen effort\'s style travels with the assist profile');
  for (const tool of ['system_overview', 'list_processes', 'network_overview', 'read_log', 'mirabilis_status', 'mirabilis_logs', 'mirabilis_architecture', 'run_command']) {
    assert.ok(system.includes(`- ${tool}:`), `${tool} should be offered`);
  }
  script = null;
  await setAccess({ level: 'chat' });
});

test('a project folder may not be the disk root or a missing path', async () => {
  await setAccess({ level: 'read' });
  for (const fsRoot of ['/', '/definitely/not/here']) {
    const res = await runStream({ goal: 'x', effort: 'high', provider: 'ollama', fsRoot });
    assert.equal(res.status, 400, fsRoot);
  }
  await setAccess({ level: 'chat' });
});

// the approval flow

test('Ask first: a write waits for approval, then runs once allowed', async () => {
  await setAccess({ level: 'bypass' });
  const target = path.join(projDir, 'approved.txt');
  script = steps([{ tool: 'write_file', args: { path: 'approved.txt', content: 'yes\n' } }], 'wrote it');
  let pendingSeen = null;
  let second = null;
  const { frames, runId } = await runStream(
    { goal: 'write approved.txt', effort: 'balanced', access: 'ask', provider: 'ollama', fsRoot: projDir },
    async (frame, id) => {
      if (frame.data?.type !== 'approval-required') return;
      assert.equal(await exists(target), false, 'nothing is written before the user answers');
      pendingSeen = await (await fetch(`${baseUrl}/api/agent/runs/${id}/approvals`, { headers: authJson() })).json();
      const res = await answer(id, frame.data.approvalId, 'allow');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      second = await answer(id, frame.data.approvalId, 'deny');
    }
  );
  assert.equal(frames.find((f) => f.event === 'run-accepted').data.access, 'ask');
  const [req] = progress(frames, 'approval-required');
  assert.ok(req, 'the run must ask before writing');
  assert.equal(req.kind, 'write');
  assert.equal(req.title, 'Write a file');
  assert.equal(req.tool, 'write_file');
  assert.equal(req.reasonCode, 'changes-files');
  assert.equal(req.alwaysLabel, 'Allow for this run');
  assert.ok(req.detail.startsWith(`${target}\n`), req.detail);
  assert.match(req.detail, /Creates a new file of 4 bytes/);
  assert.equal(pendingSeen.pending.length, 1);
  assert.equal(pendingSeen.pending[0].approvalId, req.approvalId);
  assert.equal(second.status, 409, 'an answered approval cannot be answered again');
  assert.deepEqual(progress(frames, 'approval-resolved').map((r) => r.decision), ['allow']);
  assert.equal(resultOf(frames).ok, true);
  assert.equal(await fs.readFile(target, 'utf8'), 'yes\n');
  assert.ok(runId);
  script = null;
});

test('a denial reaches the model as a denial, with the user\'s note', async () => {
  await setAccess({ level: 'bypass' });
  seenPrompts.length = 0;
  script = steps([{ tool: 'run_command', args: { command: 'touch denied.txt' } }], 'the user said no');
  const { frames } = await runStream(
    { goal: 'touch denied.txt', effort: 'balanced', access: 'ask', provider: 'ollama', fsRoot: projDir },
    async (frame, id) => {
      if (frame.data?.type === 'approval-required') await answer(id, frame.data.approvalId, 'deny', 'not today');
    }
  );
  const [req] = progress(frames, 'approval-required');
  assert.equal(req.kind, 'command');
  assert.equal(req.detail, 'touch denied.txt');
  assert.equal(req.alwaysLabel, 'Always allow `touch`');
  assert.ok(seenPrompts.some((p) => p.user.includes('ERROR: The user denied this action. Note: not today')),
    'the model must be told it was denied, and why');
  assert.equal(await exists(path.join(projDir, 'denied.txt')), false);
  assert.equal(resultOf(frames).ok, true);
  script = null;
});

test('Always allow saves the command rule, and the next run does not ask', async () => {
  await setAccess({ level: 'bypass', allowCommands: [] });
  script = steps([{ tool: 'run_command', args: { command: 'touch always-1.txt' } }]);
  const first = await runStream(
    { goal: 'touch always-1.txt', effort: 'balanced', access: 'ask', provider: 'ollama', fsRoot: projDir },
    async (frame, id) => {
      if (frame.data?.type === 'approval-required') await answer(id, frame.data.approvalId, 'always');
    }
  );
  assert.equal(progress(first.frames, 'approval-required').length, 1);
  assert.equal(await exists(path.join(projDir, 'always-1.txt')), true);

  const access = await (await fetch(`${baseUrl}/api/access`, { headers: authJson() })).json();
  assert.deepEqual(access.allowCommands, ['touch']);
  const onDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'access.json'), 'utf8'));
  assert.deepEqual(onDisk.allowCommands, ['touch']);

  script = steps([{ tool: 'run_command', args: { command: 'touch always-2.txt' } }]);
  const second = await runStream({ goal: 'touch always-2.txt', effort: 'balanced', access: 'ask', provider: 'ollama', fsRoot: projDir });
  assert.equal(progress(second.frames, 'approval-required').length, 0, 'the saved rule covers it');
  assert.equal(await exists(path.join(projDir, 'always-2.txt')), true);
  await setAccess({ allowCommands: [] });
  script = null;
});

test('Bypass never asks, and a write still keeps the old bytes', async () => {
  await setAccess({ level: 'bypass' });
  const target = path.join(projDir, 'keep.txt');
  await fs.writeFile(target, 'original\n', 'utf8');
  script = steps([
    { tool: 'write_file', args: { path: 'keep.txt', content: 'changed\n' } },
    { tool: 'run_command', args: { command: 'touch bypass.txt' } }
  ]);
  const { frames, runId } = await runStream({ goal: 'change things', effort: 'balanced', provider: 'ollama', fsRoot: projDir });
  assert.equal(frames.find((f) => f.event === 'run-accepted').data.access, 'bypass');
  assert.equal(progress(frames, 'approval-required').length, 0);
  assert.equal(await fs.readFile(target, 'utf8'), 'changed\n');
  assert.equal(await exists(path.join(projDir, 'bypass.txt')), true);

  const beforeDir = path.join(dataDir, 'agent-runs', runId, 'before');
  const copies = await fs.readdir(beforeDir);
  assert.equal(copies.length, 1);
  assert.equal(await fs.readFile(path.join(beforeDir, copies[0]), 'utf8'), 'original\n');
  const audit = (await fs.readFile(path.join(dataDir, 'agent-runs', `${runId}.jsonl`), 'utf8'))
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(audit.some((e) => e.kind === 'backup' && e.path === target), 'the copy is recorded in the run log');
  script = null;
});

test('Read only denies writes and never asks', async () => {
  await setAccess({ level: 'bypass' });
  script = steps([{ tool: 'write_file', args: { path: 'read-only.txt', content: 'x' } }], 'could not write');
  const { frames } = await runStream({ goal: 'write a file', effort: 'balanced', access: 'read', provider: 'ollama', fsRoot: projDir });
  assert.equal(progress(frames, 'approval-required').length, 0);
  const results = progress(frames, 'tool-result');
  assert.equal(results[0].ok, false);
  assert.match(results[0].observation, /Read only: changing files is off/);
  assert.equal(await exists(path.join(projDir, 'read-only.txt')), false);
  script = null;
});

test('approval routes answer 404, 400 and 409 plainly', async () => {
  await setAccess({ level: 'bypass' });
  const missing = await answer('00000000-0000-0000-0000-000000000000', 'x', 'allow');
  assert.equal(missing.status, 404);
  assert.equal((await fetch(`${baseUrl}/api/agent/runs/nope/approvals`, { headers: authJson() })).status, 404);

  script = steps([{ tool: 'run_command', args: { command: 'touch codes.txt' } }]);
  const statuses = {};
  await runStream(
    { goal: 'status codes', effort: 'balanced', access: 'ask', provider: 'ollama', fsRoot: projDir },
    async (frame, id) => {
      if (frame.data?.type !== 'approval-required') return;
      statuses.bad = (await answer(id, frame.data.approvalId, 'maybe')).status;
      statuses.unknown = (await answer(id, 'not-an-approval', 'allow')).status;
      statuses.ok = (await answer(id, frame.data.approvalId, 'deny')).status;
      statuses.again = (await answer(id, frame.data.approvalId, 'allow')).status;
    }
  );
  assert.deepEqual(statuses, { bad: 400, unknown: 404, ok: 200, again: 409 });
  script = null;
});

test('stopping a run cancels the approval it is waiting on', async () => {
  await setAccess({ level: 'bypass' });
  script = steps([{ tool: 'run_command', args: { command: 'touch stopped.txt' } }]);
  const { frames } = await runStream(
    { goal: 'stop while waiting', effort: 'balanced', access: 'ask', provider: 'ollama', fsRoot: projDir },
    async (frame, id) => {
      if (frame.data?.type !== 'approval-required') return;
      const res = await fetch(`${baseUrl}/api/agent/runs/${id}/stop`, { method: 'POST', headers: authJson() });
      assert.equal(res.status, 200);
    }
  );
  assert.deepEqual(progress(frames, 'approval-resolved').map((r) => r.decision), ['cancelled']);
  assert.equal(resultOf(frames).stopReason, 'cancelled');
  assert.equal(await exists(path.join(projDir, 'stopped.txt')), false);
  script = null;
  await setAccess({ level: 'chat' });
});

test('concurrent runs are capped on the server, not just in the UI', async () => {
  // Any token holder can call this endpoint, so the UI guard is not enough.
  replyIndex = 0; script = null;
  const slowGoal = 'concurrency probe';
  const attempts = await Promise.all(Array.from({ length: 6 }, () =>
    fetch(`${baseUrl}/api/agent/runs`, {
      method: 'POST',
      headers: authJson(),
      body: JSON.stringify({ goal: slowGoal, effort: 'high', provider: 'ollama' })
    }).then(async (r) => ({ status: r.status, body: await r.text() }))
  ));

  const refused = attempts.filter((a) => a.status === 429);
  assert.ok(refused.length > 0, 'some of six simultaneous runs must be refused');
  for (const r of refused) {
    assert.match(r.body, /already in progress/, 'the refusal should say why');
    assert.match(r.body, /limit/, 'and what the limit is');
  }
});
