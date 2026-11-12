import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { serveMachineMcp, SERVER_NAME, PROTOCOL_VERSIONS } from './machineServer.js';
import { APP_SEMVER } from '../version.js';

const SERVER = fileURLToPath(new URL('./machineServer.js', import.meta.url));

const made = [];
after(() => Promise.all(made.map((d) => fs.rm(d, { recursive: true, force: true }))));

/** A stand-in for createMachineTools: named handlers, each (args, ctx) => result. */
function fakeMachine(handlers) {
  return {
    tools: Object.keys(handlers).map((name) => ({
      name, title: name, description: `The ${name} tool.`, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }
    })),
    has: (name) => Object.prototype.hasOwnProperty.call(handlers, name),
    call: (name, args, ctx) => handlers[name](args, ctx)
  };
}

const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });

/** The engine on in-memory streams, with a way to wait for answers. */
function harness(machine, opts = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const logs = [];
  const server = serveMachineMcp({ input, output, machine, log: (line) => logs.push(line), ...opts });
  const messages = [];
  const waiters = [];
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      messages.push(JSON.parse(line));
      for (const w of [...waiters]) w();
    }
  });
  const send = (value) => input.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
  /** The first message that matches, waiting for it if needed. */
  const next = (match, ms = 2000) => new Promise((resolve, reject) => {
    const check = () => {
      const found = messages.find(match);
      if (!found) return;
      waiters.splice(waiters.indexOf(check), 1);
      clearTimeout(timer);
      resolve(found);
    };
    const timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(check), 1);
      reject(new Error(`no matching message; got ${JSON.stringify(messages)}`));
    }, ms);
    waiters.push(check);
    check();
  });
  const byId = (id) => next((m) => !Array.isArray(m) && m.id === id);
  const request = (id, method, params) => {
    send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return byId(id);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  return { input, output, logs, server, messages, send, next, byId, request, settle };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// The protocol

test('initialize answers with the client version when supported, else the newest', async () => {
  const h = harness(fakeMachine({}));
  for (const [id, asked, expected] of [[1, '2025-03-26', '2025-03-26'], [2, '2024-11-05', '2024-11-05'], [3, '2025-06-18', '2025-06-18'], [4, '1999-01-01', '2025-06-18'], [5, undefined, '2025-06-18']]) {
    const res = await h.request(id, 'initialize', asked ? { protocolVersion: asked, capabilities: {}, clientInfo: { name: 'test', version: '1' } } : undefined);
    assert.deepEqual(res, {
      jsonrpc: '2.0', id,
      result: { protocolVersion: expected, capabilities: { tools: {} }, serverInfo: { name: 'mirabilis-machine', version: APP_SEMVER } }
    });
  }
  assert.equal(SERVER_NAME, 'mirabilis-machine');
  assert.deepEqual(PROTOCOL_VERSIONS, ['2025-06-18', '2025-03-26', '2024-11-05']);
});

test('ping, tools/list and tools/call answer; notifications and stray responses do not', async () => {
  const h = harness(fakeMachine({ echo: async (args) => text(args.say) }));
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 99, result: {} });
  assert.deepEqual(await h.request('p', 'ping'), { jsonrpc: '2.0', id: 'p', result: {} });
  const list = await h.request(2, 'tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ['echo']);
  const call = await h.request(3, 'tools/call', { name: 'echo', arguments: { say: 'hi' } });
  assert.deepEqual(call, { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'hi' }] } });
  await h.settle();
  assert.equal(h.messages.length, 3, 'the notification and the stray response got no answer');
  assert.ok(h.logs.some((l) => /^echo ok in \d+ms$/.test(l)));
});

test('protocol errors use the JSON-RPC codes', async () => {
  const h = harness(fakeMachine({ echo: async () => text('x') }));
  h.send('{not json');
  assert.deepEqual(await h.next((m) => m.error?.code === -32700), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } });
  assert.deepEqual((await h.request(1, 'resources/list')).error, { code: -32601, message: 'Method not found: resources/list' });
  assert.deepEqual((await h.request(2, 'tools/call', { name: 'nope' })).error, { code: -32602, message: 'Unknown tool: nope' });
  assert.deepEqual((await h.request(3, 'tools/call', {})).error, { code: -32602, message: 'tools/call needs a tool name.' });
  h.send({ jsonrpc: '2.0', id: 4 });
  assert.deepEqual((await h.byId(4)).error, { code: -32600, message: 'Invalid request.' });
  h.send('42');
  assert.ok(await h.next((m) => m.error?.code === -32600 && m.id === null));
  h.send('[]');
  assert.ok(await h.next((m) => m.error?.message === 'Invalid request: empty batch.'));
});

test('a batch gets one array of answers, without the notifications', async () => {
  const h = harness(fakeMachine({ echo: async (args) => text(args.n) }));
  h.send([
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { n: 7 } } }
  ]);
  const batch = await h.next((m) => Array.isArray(m));
  assert.deepEqual(batch, [
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '7' }] } }
  ]);
});

test('a tool that throws is an internal error, and the server keeps serving', async () => {
  const h = harness(fakeMachine({ boom: async () => { throw new Error('bug'); } }));
  assert.deepEqual((await h.request(1, 'tools/call', { name: 'boom' })).error, { code: -32603, message: 'Internal error.' });
  assert.deepEqual((await h.request(2, 'ping')).result, {});
  assert.ok(h.logs.some((l) => /request failed: Error: bug/.test(l)));
});

// Bounded calls

test('a cancelled call stops its tool and gets no answer', async () => {
  let seen = null;
  const h = harness(fakeMachine({
    slow: (_args, { signal }) => new Promise((resolve) => {
      seen = signal;
      signal.addEventListener('abort', () => resolve(text('stopped')), { once: true });
    })
  }));
  h.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'slow', arguments: {} } });
  await h.settle();
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7, reason: 'Timed out.' } });
  await h.settle();
  assert.equal(seen.aborted, true);
  assert.deepEqual((await h.request(8, 'ping')).result, {});
  await h.settle();
  assert.equal(h.messages.some((m) => m.id === 7), false);
});

test('a call past the deadline answers with a plain error and aborts the tool', async () => {
  let seen = null;
  const h = harness(fakeMachine({ hang: (_args, { signal }) => { seen = signal; return new Promise(() => {}); } }), { callDeadlineMs: 150 });
  const res = await h.request(1, 'tools/call', { name: 'hang' });
  assert.deepEqual(res.result, { content: [{ type: 'text', text: 'hang did not finish within 150ms.' }], isError: true });
  assert.equal(seen.aborted, true);
});

test('calls beyond the concurrency limit queue, and a queued call can be cancelled', async () => {
  const gates = [deferred(), deferred()];
  const started = [];
  const h = harness(fakeMachine({
    work: async (args) => {
      started.push(args.n);
      if (gates[args.n]) await gates[args.n].promise;
      return text(args.n);
    }
  }), { maxConcurrent: 1 });
  h.send({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'work', arguments: { n: 0 } } });
  h.send({ jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'work', arguments: { n: 1 } } });
  h.send({ jsonrpc: '2.0', id: 'c', method: 'tools/call', params: { name: 'work', arguments: { n: 2 } } });
  await h.settle();
  assert.deepEqual(started, [0], 'one at a time');
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'b' } });
  gates[0].resolve();
  assert.equal((await h.byId('a')).result.content[0].text, '0');
  assert.equal((await h.byId('c')).result.content[0].text, '2');
  assert.deepEqual(started, [0, 2], 'the cancelled call never started');
  assert.equal(h.messages.some((m) => m.id === 'b'), false);
});

test('cancelling a call frees its slot at once, even when the tool ignores the signal', async () => {
  const h = harness(fakeMachine({ stuck: () => new Promise(() => {}), quick: async () => text('quick') }), { maxConcurrent: 1 });
  h.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'stuck' } });
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'quick' } });
  await h.settle();
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  assert.equal((await h.byId(2)).result.content[0].text, 'quick');
  assert.equal(h.messages.some((m) => m.id === 1), false);
});

test('closing the input ends the server and aborts what is running', async () => {
  let seen = null;
  const h = harness(fakeMachine({ hang: (_args, { signal }) => { seen = signal; return new Promise(() => {}); } }));
  h.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hang' } });
  await h.settle();
  h.input.end();
  await h.server.closed;
  assert.equal(seen.aborted, true);
});

test('ids 1 and "1" are different calls', async () => {
  const gate = deferred();
  const h = harness(fakeMachine({ wait: async () => { await gate.promise; return text('done'); } }));
  h.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait' } });
  h.send({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'wait' } });
  await h.settle();
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: '1' } });
  gate.resolve();
  assert.equal((await h.byId(1)).result.content[0].text, 'done');
  await h.settle();
  assert.equal(h.messages.some((m) => m.id === '1'), false);
});

// The real server

test('the real server speaks MCP over stdio, honours Go Dark and exits when stdin closes', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-machine-server-'));
  made.push(dataDir);
  await fs.writeFile(path.join(dataDir, 'go-dark.json'), JSON.stringify({ on: true }));
  const listener = net.createServer((s) => s.destroy());
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MIRABILIS_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  const lines = [];
  const pending = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      lines.push(line);
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
    }
  });
  const ask = (id, method, params) => new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    const init = await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'mirabilis-machine');
    assert.equal(init.result.serverInfo.version, APP_SEMVER);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = await ask(2, 'tools/list', {});
    assert.equal(list.result.tools.length, 13);
    assert.ok(list.result.tools.every((t) => t.inputSchema?.type === 'object' && typeof t.annotations?.readOnlyHint === 'boolean'));
    const port = await ask(3, 'tools/call', { name: 'check_port', arguments: { host: '127.0.0.1', port: listener.address().port } });
    assert.equal(JSON.parse(port.result.content[0].text).state, 'open');
    const dark = await ask(4, 'tools/call', { name: 'dns_lookup', arguments: { name: 'example.com' } });
    assert.deepEqual(dark.result, { content: [{ type: 'text', text: 'Blocked by Go Dark. Turn it off to reach example.com.' }], isError: true });
    const self = await ask(5, 'tools/call', { name: 'kill_process', arguments: { pid: process.pid } });
    assert.equal(self.result.content[0].text, 'Refusing to stop Mirabilis itself.', 'the parent is the backend');
    child.stdin.write('{oops\n');
    const bad = await new Promise((resolve) => pending.set(null, resolve));
    assert.equal(bad.error.code, -32700);
    child.stdin.end();
    let timer;
    const result = await Promise.race([exited, new Promise((r) => { timer = setTimeout(() => r('still running'), 5000); })]);
    clearTimeout(timer);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.ok(lines.every((l) => l.startsWith('{')), 'stdout carries only the protocol');
    assert.match(stderr, new RegExp(`^mirabilis-machine ${APP_SEMVER.replace(/\./g, '\\.')} ready on ${process.platform}`));
    assert.match(stderr, /check_port ok in \d+ms/);
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => listener.close(r));
  }
});
