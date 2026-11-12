// /api/connectors on a bare express app with a fake guard: auth, CRUD, per-tool
// permissions, a user-initiated tool call, logs and restart against the stdio fake server.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConnectorManager } from '../mcp/connectors.js';
import { createConnectorsRouter } from './connectors.js';

const FAKE = fileURLToPath(new URL('../mcp/testdata/fakeMcpServer.mjs', import.meta.url));
const TOKEN = 'test-session-token';

/** @type {any} */
let server;
/** @type {any} */
let manager;
let base = '';
let dataDir = '';

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-connectors-route-'));
  manager = createConnectorManager({ dataDir });
  /** @type {import('express').RequestHandler} */
  const guard = (req, res, next) => {
    if (req.headers.authorization === `Bearer ${TOKEN}`) next();
    else res.status(401).json({ error: 'Unauthorized' });
  };
  const app = express();
  app.use('/api/connectors', createConnectorsRouter({ manager, guard }));
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}/api/connectors`;
});

after(async () => {
  await manager.shutdown();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
});

/**
 * @param {string} method
 * @param {string} [route]
 * @param {any} [body]
 * @param {{auth?: boolean, raw?: string}} [opts]
 */
async function call(method, route = '', body, { auth = true, raw } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${TOKEN}`;
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
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

test('every route answers 401 without the session token, and nothing is created', async () => {
  const routes = [
    ['GET', ''], ['GET', '/catalog'], ['POST', ''], ['GET', '/x'], ['PATCH', '/x'], ['DELETE', '/x'],
    ['POST', '/x/restart'], ['GET', '/x/logs'], ['POST', '/x/tools/echo/call']
  ];
  for (const [method, route] of routes) {
    const res = await call(method, route, method === 'GET' ? undefined : {}, { auth: false });
    assert.equal(res.status, 401, `${method} ${route}`);
  }
  const attempt = await call('POST', '', { name: 'Fake', command: process.execPath, args: [FAKE] }, { auth: false });
  assert.equal(attempt.status, 401);
  assert.deepEqual((await call('GET')).body, { connectors: [] });
});

test('the router will not mount without a guard', () => {
  assert.throws(() => createConnectorsRouter(/** @type {any} */ ({ manager })), /guard/);
});

test('GET /catalog lists the presets with availability', async () => {
  const res = await call('GET', '/catalog');
  assert.equal(res.status, 200);
  assert.equal(res.body.presets.length, 8);
  assert.ok(res.body.presets.every((p) => typeof p.available === 'boolean' && Array.isArray(p.fields)));
});

test('full lifecycle: create, list, permissions, tool calls, logs, restart, toggle, delete', async () => {
  const created = await call('POST', '', { name: 'Fake', transport: 'stdio', command: process.execPath, args: [FAKE] });
  assert.equal(created.status, 201);
  const c = created.body.connector;
  assert.equal(c.status.state, 'ready', c.status.error);
  assert.equal(c.status.toolCount, 2);
  assert.deepEqual(c.tools.map((t) => [t.name, t.readOnly, t.permission]), [['echo', true, 'allow'], ['write_note', false, 'ask']]);

  assert.deepEqual((await call('GET')).body.connectors.map((x) => x.id), [c.id]);
  assert.equal((await call('GET', `/${c.id}`)).body.connector.name, 'Fake');
  const renamed = await call('PATCH', `/${c.id}`, { name: 'Fake Renamed' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.connector.name, 'Fake Renamed');

  const off = await call('PATCH', `/${c.id}`, { tools: { write_note: 'off' } });
  assert.equal(off.status, 200);
  assert.equal(off.body.connector.tools.find((t) => t.name === 'write_note').permission, 'off');
  assert.equal(off.body.connector.status.state, 'ready', 'a permission change does not restart');
  assert.equal((await call('PATCH', `/${c.id}`, { tools: { write_note: 'sometimes' } })).status, 400);
  assert.equal((await call('PATCH', `/${c.id}`, { url: 'http://localhost/mcp' })).status, 400);

  // The click is the approval: ask tools run, off tools never do.
  const echo = await call('POST', `/${c.id}/tools/echo/call`, { args: { text: 'hi' } });
  assert.equal(echo.status, 200);
  assert.deepEqual(echo.body, { result: { text: 'hi', isError: false } });
  const refused = await call('POST', `/${c.id}/tools/write_note/call`, { args: { note: 'n' } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /turned off/);
  await call('PATCH', `/${c.id}`, { tools: { write_note: 'ask' } });
  const asked = await call('POST', `/${c.id}/tools/write_note/call`, { args: { note: 'n' } });
  assert.equal(asked.status, 200);
  assert.equal(asked.body.result.text, 'Saved: n\n[image]\n[resource: file:///notes/1]');
  assert.equal((await call('POST', `/${c.id}/tools/missing/call`, {})).status, 404);
  assert.equal((await call('POST', `/${c.id}/tools/echo/call`, { args: [1, 2] })).status, 400);

  const logs = await call('GET', `/${c.id}/logs`);
  assert.equal(logs.status, 200);
  assert.ok(logs.body.lines.includes('fake server ready'));

  const restarted = await call('POST', `/${c.id}/restart`);
  assert.equal(restarted.status, 200);
  const fresh = restarted.body.connector;
  assert.equal(fresh.status.state, 'ready');
  assert.notEqual(fresh.status.pid, c.status.pid);
  assert.ok(gone(c.status.pid), 'the old process is gone');
  const relogged = await call('GET', `/${c.id}/logs`);
  assert.equal(relogged.body.lines.filter((l) => l.startsWith('[mirabilis] Starting')).length, 2);

  const disabled = await call('PATCH', `/${c.id}`, { enabled: false });
  assert.equal(disabled.body.connector.status.state, 'off');
  assert.ok(gone(fresh.status.pid), 'turning it off stops the program');
  const restartOff = await call('POST', `/${c.id}/restart`);
  assert.equal(restartOff.status, 400);
  assert.match(restartOff.body.error, /Turn it on/);
  const enabled = await call('PATCH', `/${c.id}`, { enabled: true });
  assert.equal(enabled.body.connector.status.state, 'ready');

  const lastPid = enabled.body.connector.status.pid;
  assert.deepEqual((await call('DELETE', `/${c.id}`)).body, { ok: true });
  assert.ok(gone(lastPid), 'removing it stops the program');
  for (const [method, route, body] of [
    ['GET', `/${c.id}`], ['DELETE', `/${c.id}`], ['PATCH', `/${c.id}`, { name: 'x' }],
    ['POST', `/${c.id}/restart`], ['GET', `/${c.id}/logs`], ['POST', `/${c.id}/tools/echo/call`, {}]
  ]) {
    const res = await call(method, route, body);
    assert.equal(res.status, 404, `${method} ${route}`);
    assert.equal(typeof res.body.error, 'string');
  }
  assert.deepEqual((await call('GET')).body, { connectors: [] });
});

test('bad input gets a 400 with a plain error', async () => {
  const bad = await call('POST', '', { transport: 'http', url: 'nope' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /http:\/\/ or https:\/\//);
  const malformed = await call('POST', '', undefined, { raw: '{ not json' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error, 'The request body is not valid JSON.');
  const notObject = await call('POST', '', [1, 2]);
  assert.equal(notObject.status, 400);
  assert.deepEqual((await call('GET')).body, { connectors: [] });
});

test('Junos from a folder: plain 400s until it has jmcp.py and devices.json, then a local connector', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-junos-route-'));
  try {
    const nowhere = path.join(dir, 'nope');
    const add = (fields, extra = {}) => call('POST', '', { preset: 'junos', fields, ...extra });
    for (const [fields, message] of [
      [{}, 'Server folder is required.'],
      [{ folder: nowhere }, `Server folder not found: ${nowhere}`],
      [{ folder: dir }, `jmcp.py not found in ${dir}`]
    ]) {
      const res = await add(fields);
      assert.equal(res.status, 400, JSON.stringify(fields));
      assert.equal(res.body.error, message);
    }
    await fs.writeFile(path.join(dir, 'jmcp.py'), '');
    const noDevices = await add({ folder: dir, devices: 'lab.json' });
    assert.equal(noDevices.status, 400);
    assert.equal(noDevices.body.error, 'Devices file not found: lab.json');
    assert.deepEqual((await call('GET')).body, { connectors: [] }, 'nothing saved on a 400');

    await fs.writeFile(path.join(dir, 'devices.json'), '{}');
    const res = await add({ folder: dir }, { enabled: false });
    assert.equal(res.status, 201);
    const c = res.body.connector;
    assert.deepEqual([c.name, c.transport, c.preset, c.cwd], ['Junos', 'stdio', 'junos', dir]);
    assert.deepEqual(c.args, [path.join(dir, 'jmcp.py'), '-f', path.join(dir, 'devices.json'), '-t', 'stdio']);
    assert.equal((await call('DELETE', `/${c.id}`)).status, 200);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a connector that fails to start is still saved and reported', async () => {
  const res = await call('POST', '', { name: 'Broken', command: process.execPath, args: [FAKE], env: { FAKE_MCP_MODE: 'fail' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.connector.status.state, 'error');
  assert.match(res.body.connector.status.error, /fatal: missing config file/);
  assert.deepEqual(res.body.connector.envKeys, ['FAKE_MCP_MODE']);
  assert.equal((await call('DELETE', `/${res.body.connector.id}`)).status, 200);
});
