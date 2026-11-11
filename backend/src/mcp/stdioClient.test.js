// Stdio MCP client against the fake server: handshake, paging, errors, and that
// stopping leaves no process behind.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { augmentPath, buildChildEnv, createStdioClient, expandTilde, findExecutable, pathOf } from './stdioClient.js';

const FAKE = fileURLToPath(new URL('./testdata/fakeMcpServer.mjs', import.meta.url));
const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } };
const clients = [];

/** @param {string} [mode] */
function fake(mode = '') {
  /** @type {string[]} */
  const lines = [];
  /** @type {any[]} */
  const exits = [];
  const client = createStdioClient({
    command: process.execPath,
    args: [FAKE],
    env: buildChildEnv(process.env, { FAKE_MCP_MODE: mode }),
    onStderr: (line) => lines.push(line),
    onExit: (info) => exits.push(info)
  });
  clients.push(client);
  return { client, lines, exits };
}

/** @param {number} pid */
function gone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

/** @param {() => boolean} check */
async function waitFor(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

after(async () => {
  await Promise.allSettled(clients.map((c) => c.stop()));
});

test('augmentPath puts the tool folders ahead of the system ones for a GUI launch', () => {
  assert.equal(
    augmentPath('/usr/bin:/bin:/usr/sbin:/sbin', { home: '/Users/u', platform: 'darwin' }),
    '/opt/homebrew/bin:/usr/local/bin:/Users/u/.local/bin:/Users/u/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  );
});

test('augmentPath leaves a full PATH alone and fills an empty one', () => {
  const full = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/u/.cargo/bin:/Users/u/.local/bin';
  assert.equal(augmentPath(full, { home: '/Users/u', platform: 'darwin' }), full);
  assert.equal(augmentPath('', { home: '/h', platform: 'linux' }), '/opt/homebrew/bin:/usr/local/bin:/h/.local/bin:/h/.cargo/bin:/usr/bin:/bin');
  assert.equal(augmentPath('C:\\Windows;C:\\Tools', { platform: 'win32' }), 'C:\\Windows;C:\\Tools');
});

test('expandTilde expands only a leading ~ and never trims', () => {
  assert.equal(expandTilde('~', '/h'), '/h');
  assert.equal(expandTilde('~/a b', '/h'), '/h/a b');
  assert.equal(expandTilde('a~/b', '/h'), 'a~/b');
  assert.equal(expandTilde(' ~/x', '/h'), ' ~/x');
});

test('buildChildEnv passes what a server needs and keeps the backend secrets back', () => {
  const env = buildChildEnv(
    { HOME: '/h', PATH: '/usr/bin', LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://proxy:8080', OPENAI_API_KEY: 'sk-x', MIRABILIS_MCP_TOKEN: 't' },
    { API_KEY: 'mine' },
    { home: '/h', platform: 'darwin' }
  );
  assert.equal(env.HOME, '/h');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.HTTPS_PROXY, 'http://proxy:8080');
  assert.equal(env.API_KEY, 'mine');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.MIRABILIS_MCP_TOKEN, undefined);
  assert.match(env.PATH, /^\/opt\/homebrew\/bin:/);
  assert.equal(buildChildEnv({ PATH: '/usr/bin' }, { PATH: '/custom' }, { home: '/h', platform: 'darwin' }).PATH.split(':')[0], '/custom');
  assert.equal(pathOf({ Path: 'C:\\x' }), 'C:\\x');
});

test('findExecutable finds executables on PATH and skips plain files', { skip: process.platform === 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-bin-'));
  try {
    await fs.writeFile(path.join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    await fs.writeFile(path.join(dir, 'plain'), 'x', { mode: 0o644 });
    assert.equal(findExecutable('tool', `${path.join(dir, 'missing')}:${dir}`), path.join(dir, 'tool'));
    assert.equal(findExecutable('plain', dir), null);
    assert.equal(findExecutable('absent', dir), null);
    assert.equal(findExecutable(path.join(dir, 'tool'), ''), path.join(dir, 'tool'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('handshake, paged tools/list, calls, then a clean stop', async () => {
  const { client, lines, exits } = fake();
  await client.start();
  const pid = /** @type {number} */ (client.pid);
  assert.ok(pid > 0);
  const init = await client.request('initialize', INIT, { timeoutMs: 10_000 });
  assert.equal(init.serverInfo.name, 'fake-mcp');
  await client.notify('notifications/initialized');
  const first = await client.request('tools/list', {});
  assert.deepEqual(first.tools.map((t) => t.name), ['echo']);
  assert.equal(first.nextCursor, 'page-2');
  const second = await client.request('tools/list', { cursor: 'page-2' });
  assert.deepEqual(second.tools.map((t) => t.name), ['write_note']);
  const out = await client.request('tools/call', { name: 'echo', arguments: { text: 'hi' } });
  assert.equal(out.content[0].text, 'hi');
  await assert.rejects(
    client.request('tools/call', { name: 'nope', arguments: {} }),
    (err) => err.rpcCode === -32602 && /Unknown tool: nope/.test(err.message)
  );
  assert.ok(lines.includes('fake server ready'));

  await client.stop();
  assert.ok(gone(pid), 'the server process is gone after stop()');
  assert.equal(exits.length, 1);
  assert.equal(exits[0].expected, true);
  assert.equal(client.running, false);
  await assert.rejects(client.request('tools/list', {}), /was stopped/);
});

test('the client answers a ping from the server', async () => {
  const { client, lines } = fake('ping');
  await client.start();
  await client.request('initialize', INIT);
  await client.notify('notifications/initialized');
  assert.ok(await waitFor(() => lines.includes('got pong')));
  await client.stop();
});

test('an unanswered request times out and is cancelled on the server', async () => {
  const { client, lines } = fake();
  await client.start();
  await client.request('initialize', INIT);
  await assert.rejects(
    client.request('tools/call', { name: 'echo', arguments: { text: '__hang__' } }, { timeoutMs: 300 }),
    /tools\/call timed out after 300ms/
  );
  assert.ok(await waitFor(() => lines.some((l) => /^cancelled \d+$/.test(l))));
  const controller = new AbortController();
  const pendingCall = client.request('tools/call', { name: 'echo', arguments: { text: '__hang__' } }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pendingCall, /Cancelled/);
  await client.stop();
});

test('a crash rejects pending requests and reports the exit', async () => {
  const { client, exits } = fake();
  await client.start();
  await client.request('initialize', INIT);
  const pid = /** @type {number} */ (client.pid);
  await assert.rejects(
    client.request('tools/call', { name: 'echo', arguments: { text: '__crash__' } }),
    /The connector exited with code 1/
  );
  assert.equal(exits.length, 1);
  assert.equal(exits[0].expected, false);
  assert.equal(exits[0].code, 1);
  assert.deepEqual(client.stderrTail(1), ['crashing on purpose']);
  assert.ok(await waitFor(() => gone(pid)));
  assert.equal(client.running, false);
});

test('a missing command fails with a plain message', async () => {
  const client = createStdioClient({ command: 'mirabilis-no-such-command-xyz', env: buildChildEnv(process.env) });
  clients.push(client);
  await assert.rejects(client.start(), /Command not found: mirabilis-no-such-command-xyz/);
  await client.stop();
});

test('stop() takes the whole process group down, grandchildren included', { skip: process.platform === 'win32' }, async () => {
  const { client, lines } = fake('grandchild');
  await client.start();
  assert.ok(await waitFor(() => lines.some((l) => l.startsWith('grandchild pid '))));
  const kid = Number(lines.find((l) => l.startsWith('grandchild pid '))?.split(' ').pop());
  const pid = /** @type {number} */ (client.pid);
  assert.ok(kid > 0 && !gone(kid), 'the grandchild is running');
  await client.stop();
  assert.ok(gone(pid));
  assert.ok(await waitFor(() => gone(kid), 3000), 'the grandchild is gone too');
});

test('terminate() alone is enough, for exit handlers that cannot await', { skip: process.platform === 'win32' }, async () => {
  const { client, lines, exits } = fake('grandchild');
  await client.start();
  assert.ok(await waitFor(() => lines.some((l) => l.startsWith('grandchild pid '))));
  const kid = Number(lines.find((l) => l.startsWith('grandchild pid '))?.split(' ').pop());
  const pid = /** @type {number} */ (client.pid);
  client.terminate();
  assert.ok(await waitFor(() => gone(pid) && gone(kid), 3000), 'program and grandchild are gone');
  assert.ok(await waitFor(() => exits.length === 1));
  assert.equal(exits[0].expected, true, 'a terminate is a planned stop, not a crash');
});

test('stop() escalates to SIGKILL when the program ignores SIGTERM and stdin',{ skip: process.platform === 'win32' }, async () => {
  const { client, lines } = fake('stubborn');
  await client.start();
  assert.ok(await waitFor(() => lines.includes('fake server ready')));
  const pid = /** @type {number} */ (client.pid);
  const started = Date.now();
  await client.stop({ graceMs: 500 });
  assert.ok(gone(pid), 'killed');
  assert.ok(Date.now() - started < 4000, 'within the grace period plus the kill');
  assert.ok(lines.includes('ignoring SIGTERM'), 'SIGTERM came first');
});
