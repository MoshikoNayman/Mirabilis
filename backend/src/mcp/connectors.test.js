// Connector manager end to end: the stdio fake server, a fake streamable-HTTP server,
// Go Dark, migration from mcp-servers.json, secrets that never leave the manager, and
// the built-in This computer connector (pointed at the fake server).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createConnectorManager, describeParameters, formatToolResult, GO_DARK_ERROR, slug, THIS_COMPUTER_ID,
  thisComputerConnector, toolKey
} from './connectors.js';
import { buildCatalog } from './catalog.js';

const FAKE = fileURLToPath(new URL('./testdata/fakeMcpServer.mjs', import.meta.url));
const SECRET = 'sk-test-abcdefghijklmnop1234';
const TOKEN = 'secret-token-1234567890';

/** @type {any[]} */
const managers = [];
/** @type {http.Server[]} */
const servers = [];
/** @type {string[]} */
const dirs = [];

after(async () => {
  await Promise.allSettled(managers.map((m) => m.shutdown()));
  for (const s of servers) s.closeAllConnections?.();
  await Promise.allSettled(servers.map((s) => new Promise((r) => s.close(r))));
  await Promise.allSettled(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function tempDir(prefix = 'mirabilis-connectors-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** No built-ins unless a test asks for them, so the real machine server never starts here. @param {any} [opts] */
async function newManager(opts = {}) {
  const dataDir = opts.dataDir || await tempDir();
  const manager = createConnectorManager({ builtins: [], ...opts, dataDir });
  managers.push(manager);
  await manager.init();
  return { manager, dataDir };
}

/**
 * A stand-in for machineServer.js: writes what it was started with to probe.json in
 * MIRABILIS_DATA_DIR, then runs the fake server.
 */
async function envProbe() {
  const file = path.join(await tempDir('mirabilis-probe-'), 'probe.mjs');
  await fs.writeFile(file, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    'const seen = {',
    '  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,',
    '  dataDir: process.env.MIRABILIS_DATA_DIR ?? null,',
    '  cwd: process.cwd(),',
    '  openAiKey: process.env.OPENAI_API_KEY ?? null',
    '};',
    "fs.writeFileSync(path.join(process.env.MIRABILIS_DATA_DIR, 'probe.json'), JSON.stringify(seen));",
    `await import(${JSON.stringify(pathToFileURL(FAKE).href)});`
  ].join('\n'));
  return file;
}

/** @param {any} [extra] */
const fakeStdio = (extra = {}) => ({ name: 'Fake', transport: 'stdio', command: process.execPath, args: [FAKE], ...extra });

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
async function waitFor(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

class EgressBlockedError extends Error {
  /** @param {string} host */
  constructor(host) {
    super(`Go Dark is on, so Mirabilis did not contact ${host}.`);
    this.name = 'EgressBlockedError';
    this.code = 'GO_DARK';
  }
}

const HTTP_TOOLS = [
  { name: 'echo', description: 'Echo over HTTP.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'write_note', description: 'Saves a note.', inputSchema: { type: 'object', properties: { note: { type: 'string' } } } }
];

/** A small streamable-HTTP MCP server: bearer auth, sessions, JSON and SSE answers. */
async function startHttpServer() {
  const state = { requests: /** @type {any[]} */ ([]), deletes: 0, sessions: new Set(), counter: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'DELETE') {
      state.deletes += 1;
      state.sessions.delete(req.headers['mcp-session-id']);
      res.writeHead(200).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      const session = req.headers['mcp-session-id'];
      state.requests.push({ method: msg.method, session, accept: req.headers.accept, protocol: req.headers['mcp-protocol-version'] });
      const json = (payload, headers = {}) => res.writeHead(200, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(payload));
      if (msg.method === 'initialize') {
        const sid = `sess-${++state.counter}`;
        state.sessions.add(sid);
        json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-http', version: '0.1.0' } } }, { 'mcp-session-id': sid });
        return;
      }
      if (!state.sessions.has(session)) {
        res.writeHead(404).end();
        return;
      }
      if (msg.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      if (msg.method === 'tools/list') {
        json({ jsonrpc: '2.0', id: msg.id, result: { tools: HTTP_TOOLS } });
        return;
      }
      if (msg.method === 'tools/call') {
        const args = msg.params.arguments || {};
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'working on it' } })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `http: ${args.text ?? args.note}` }] } })}\n\n`);
        res.end();
        return;
      }
      json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown method' } });
    });
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {any} */ (server.address());
  return { state, port, url: `http://127.0.0.1:${port}/mcp` };
}

test('stdio: the fake server reaches ready, lists its tools and answers calls', async () => {
  const { manager, dataDir } = await newManager();
  const c = await manager.create(fakeStdio());
  assert.equal(c.status.state, 'ready', c.status.error);
  assert.equal(c.status.serverName, 'fake-mcp');
  assert.equal(c.status.serverVersion, '1.2.3');
  assert.equal(c.status.toolCount, 2);
  assert.deepEqual(c.tools.map((t) => [t.name, t.title, t.readOnly, t.permission]), [
    ['echo', 'Echo', true, 'allow'],
    ['write_note', 'write_note', false, 'ask']
  ]);

  assert.deepEqual(await manager.callTool(c.id, 'echo', { text: 'hello' }), {
    text: 'hello',
    isError: false,
    raw: { content: [{ type: 'text', text: 'hello' }] }
  });
  const note = await manager.callTool(c.id, 'write_note', { note: 'hi' });
  assert.equal(note.text, 'Saved: hi\n[image]\n[resource: file:///notes/1]');
  assert.equal((await manager.callTool(c.id, 'echo', { text: '__fail__' })).isError, true);
  const long = await manager.callTool(c.id, 'echo', { text: 'x', repeat: 13000 });
  assert.ok(long.text.startsWith('x'.repeat(12000)));
  assert.match(long.text, /\n\[Truncated: showing 12000 of 13000 characters\.\]$/);
  await assert.rejects(manager.callTool(c.id, 'nope', {}), (err) => err.status === 404);
  await assert.rejects(manager.callTool(c.id, 'echo', [1]), (err) => err.status === 400);
  await assert.rejects(manager.callTool('no-such-id', 'echo', {}), (err) => err.status === 404);

  const file = path.join(dataDir, 'connectors.json');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600, 'connectors.json is owner-only');
  const stored = JSON.parse(await fs.readFile(file, 'utf8')).connectors[0];
  assert.deepEqual(stored.tools, { echo: 'allow', write_note: 'ask' });

  const pid = c.status.pid;
  await manager.shutdown();
  assert.ok(gone(pid), 'shutdown() leaves no process behind');
});

test('secrets never leave the manager: list, get and logs', async () => {
  const { manager } = await newManager({ env: { ...process.env, OPENAI_API_KEY: 'sk-backend-secret-000000000000' } });
  const c = await manager.create(fakeStdio({ env: { FAKE_MCP_SECRET: SECRET } }));
  assert.equal(c.status.state, 'ready', c.status.error);
  const h = await manager.create({
    name: 'Remote',
    transport: 'http',
    url: 'http://127.0.0.1:9/mcp?key=abc123secret',
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Api-Key': 'another-secret-value' },
    enabled: false
  });
  const listed = JSON.stringify([manager.list(), manager.get(c.id), manager.get(h.id)]);
  for (const secret of [SECRET, TOKEN, 'another-secret-value', 'abc123secret']) {
    assert.ok(!listed.includes(secret), `list() leaked ${secret}`);
  }
  assert.deepEqual(manager.get(c.id).envKeys, ['FAKE_MCP_SECRET']);
  assert.deepEqual(manager.get(c.id).env, ['FAKE_MCP_SECRET'], 'env holds names only');
  assert.equal(manager.get(c.id).hasSecrets, true);
  assert.deepEqual(manager.get(h.id).headerKeys, ['Authorization', 'X-Api-Key']);
  assert.deepEqual(manager.get(h.id).headers, ['Authorization', 'X-Api-Key'], 'headers holds names only');
  assert.equal(manager.get(h.id).url, 'http://127.0.0.1:9/mcp?key=***');

  const logs = manager.logs(c.id);
  assert.ok(logs.includes('fake server ready'), logs.join('\n'));
  assert.ok(logs.includes('using key [redacted]'), logs.join('\n'));
  assert.ok(!logs.join('\n').includes(SECRET));
  assert.ok(!logs.includes('leaked OPENAI_API_KEY'), 'the backend environment is not handed to the server');
});

test('agentTools offers ready tools with prompt-ready parameters and drops tools set to off', async () => {
  const { manager } = await newManager();
  const c = await manager.create(fakeStdio({ name: 'My Fake Server!' }));
  let tools = manager.agentTools();
  assert.deepEqual(Object.keys(tools).sort(), ['my_fake_server__echo', 'my_fake_server__write_note']);
  const echo = tools.my_fake_server__echo;
  assert.equal(echo.kind, 'connector');
  assert.equal(echo.readOnly, true);
  assert.equal(echo.mutating, false);
  assert.equal(echo.permission, 'allow');
  assert.equal(echo.connectorId, c.id);
  assert.equal(echo.connectorName, 'My Fake Server!');
  assert.equal(echo.mcpTool, 'echo');
  assert.equal(echo.description, 'Returns the text it is given. (connector: My Fake Server!)');
  assert.deepEqual(echo.parameters, { text: 'string (required, Text to return)', repeat: 'number (optional, How many times to repeat it)' });
  assert.deepEqual(await echo.execute({ text: 'via agent' }), { text: 'via agent' });
  await assert.rejects(() => echo.execute({ text: '__fail__' }));
  const note = tools.my_fake_server__write_note;
  assert.equal(note.permission, 'ask');
  assert.equal(note.readOnly, false);

  await manager.update(c.id, { tools: { write_note: 'off' } });
  assert.equal(note.permission, 'off', 'permission is read live');
  await assert.rejects(note.execute({ note: 'x' }), /turned off/);
  tools = manager.agentTools();
  assert.deepEqual(Object.keys(tools), ['my_fake_server__echo']);

  // Same slug from a second connector: keys stay unique.
  await manager.create(fakeStdio({ name: 'my fake server' }));
  assert.deepEqual(Object.keys(manager.agentTools()).sort(), ['my_fake_server__echo', 'my_fake_server__echo_2', 'my_fake_server__write_note']);

  const off = await manager.update(c.id, { enabled: false });
  assert.equal(off.status.state, 'off');
  assert.equal(off.tools.length, 2, 'a stopped connector still lists its tools');
  assert.ok(!Object.values(manager.agentTools()).some((t) => t.connectorId === c.id));
});

test('settings and permissions survive a restart of the manager', async () => {
  const dataDir = await tempDir();
  const first = createConnectorManager({ dataDir, builtins: [] });
  managers.push(first);
  await first.init();
  const c = await first.create(fakeStdio());
  const second = await first.create(fakeStdio({ name: 'Fake Two' }));
  await first.update(c.id, { tools: { echo: 'ask' } });
  await first.shutdown();

  const { manager } = await newManager({ dataDir });
  assert.deepEqual(manager.list().map((x) => x.status.state), ['starting', 'starting'], 'init does not wait for them');
  assert.ok(await waitFor(() => manager.list().every((x) => x.status.state === 'ready')), 'enabled connectors start on init');
  assert.equal(manager.get(c.id).tools.find((t) => t.name === 'echo').permission, 'ask');
  assert.equal(manager.get(second.id).tools.find((t) => t.name === 'echo').permission, 'allow');
});

test('changing the command restarts the connector', async () => {
  const { manager } = await newManager();
  const c = await manager.create(fakeStdio());
  const updated = await manager.update(c.id, { env: { FAKE_MCP_SECRET: SECRET } });
  assert.equal(updated.status.state, 'ready');
  assert.notEqual(updated.status.pid, c.status.pid);
  assert.ok(gone(c.status.pid));
  assert.deepEqual(updated.envKeys, ['FAKE_MCP_SECRET']);
  const cleared = await manager.update(c.id, { env: { FAKE_MCP_SECRET: null } });
  assert.deepEqual(cleared.envKeys, []);
  await assert.rejects(manager.update(c.id, { url: 'http://localhost/mcp' }), (err) => err.status === 400);
  await assert.rejects(manager.update(c.id, { transport: 'http' }), /cannot switch/);
  await assert.rejects(manager.update(c.id, { enabled: 'yes' }), (err) => err.status === 400);
  await assert.rejects(manager.update(c.id, { name: '' }), (err) => err.status === 400);
});

test('a server that fails at startup is saved with its error and not restarted', async () => {
  const { manager } = await newManager();
  const c = await manager.create(fakeStdio({ env: { FAKE_MCP_MODE: 'fail' } }));
  assert.equal(c.status.state, 'error');
  assert.match(c.status.error, /exited with code 2/);
  assert.match(c.status.error, /fatal: missing config file/);
  assert.equal(manager.list().length, 1);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(manager.get(c.id).status.state, 'error');
  assert.equal(manager.logs(c.id).filter((l) => l.startsWith('[mirabilis] Starting')).length, 1);
});

test('a missing command or folder is a plain error', async () => {
  const { manager } = await newManager();
  const c = await manager.create({ command: 'mirabilis-no-such-command-xyz' });
  assert.equal(c.name, 'mirabilis-no-such-command-xyz');
  assert.equal(c.status.state, 'error');
  assert.match(c.status.error, /Command not found: mirabilis-no-such-command-xyz/);
});

test('a crash after ready restarts at most three times, then shows the last output', async () => {
  const { manager } = await newManager();
  const c = await manager.create(fakeStdio());
  for (let round = 1; round <= 3; round += 1) {
    await assert.rejects(manager.callTool(c.id, 'echo', { text: '__crash__' }), (err) => err.status === 500);
    assert.ok(await waitFor(() => manager.get(c.id).status.state === 'ready', 15_000), `restart ${round}`);
  }
  await assert.rejects(manager.callTool(c.id, 'echo', { text: '__crash__' }));
  assert.ok(await waitFor(() => manager.get(c.id).status.state === 'error'));
  const { error } = manager.get(c.id).status;
  assert.match(error, /Stopped after 3 restarts in 5 minutes/);
  assert.match(error, /crashing on purpose/);
  assert.equal(manager.logs(c.id).filter((l) => l.startsWith('[mirabilis] Restarting')).length, 3);
  const again = await manager.restart(c.id);
  assert.equal(again.status.state, 'ready', 'a manual restart clears the count');
});

test('http: bearer token, session id, SSE answers and a new session when the old one ends', async () => {
  const remote = await startHttpServer();
  const { manager } = await newManager();
  const c = await manager.create({ name: 'Remote', transport: 'http', url: remote.url, headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(c.status.state, 'ready', c.status.error);
  assert.equal(c.status.serverName, 'fake-http');
  assert.equal(c.status.pid, null);
  assert.deepEqual(c.tools.map((t) => [t.name, t.permission]), [['echo', 'allow'], ['write_note', 'ask']]);

  const out = await manager.callTool(c.id, 'echo', { text: 'over http' });
  assert.equal(out.text, 'http: over http');
  assert.ok(manager.logs(c.id).includes('[info] working on it'), 'SSE notifications reach the log');
  const later = remote.state.requests.filter((r) => r.method !== 'initialize');
  assert.ok(later.length >= 3);
  assert.ok(later.every((r) => r.session === 'sess-1'), 'the session id rides along');
  assert.ok(later.every((r) => r.protocol === '2025-06-18'), 'the negotiated protocol version rides along');
  assert.ok(remote.state.requests.every((r) => r.accept === 'application/json, text/event-stream'));

  remote.state.sessions.clear();
  assert.equal((await manager.callTool(c.id, 'echo', { text: 'again' })).text, 'http: again');
  assert.equal(remote.state.counter, 2, 'one new session');

  await manager.update(c.id, { enabled: false });
  assert.equal(remote.state.deletes, 1, 'turning it off ends the session');
});

test('http: a wrong token is a plain error and the name defaults to the host', async () => {
  const remote = await startHttpServer();
  const { manager } = await newManager();
  const c = await manager.create({ transport: 'http', url: remote.url, bearerToken: 'wrong-token-0000000' });
  assert.equal(c.name, `127.0.0.1:${remote.port}`);
  assert.equal(c.status.state, 'error');
  assert.match(c.status.error, /refused the credentials \(HTTP 401\)/);
  assert.ok(!JSON.stringify(manager.list()).includes('wrong-token-0000000'));
});

test('Go Dark: a remote connector is blocked without being contacted', async () => {
  let calls = 0;
  /** @type {any} */
  const fetch = async (input) => {
    calls += 1;
    throw new EgressBlockedError(new URL(String(input)).host);
  };
  const { manager } = await newManager({ isGoDark: () => true, fetch });
  const c = await manager.create({ name: 'Cloud', transport: 'http', url: 'https://mcp.example.com/mcp' });
  assert.equal(c.status.state, 'error');
  assert.equal(c.status.error, GO_DARK_ERROR);
  assert.equal(calls, 0);
  assert.deepEqual(manager.agentTools(), {});
});

test('Go Dark: EgressBlockedError from fetch becomes Blocked by Go Dark', async () => {
  /** @type {any} */
  const fetch = async (input) => {
    throw new EgressBlockedError(new URL(String(input)).host);
  };
  const { manager } = await newManager({ isGoDark: () => false, fetch });
  const c = await manager.create({ name: 'Cloud', transport: 'http', url: 'https://mcp.example.com/mcp' });
  assert.equal(c.status.state, 'error');
  assert.equal(c.status.error, GO_DARK_ERROR);
  manager.list();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(manager.get(c.id).status.state, 'error', 'no retry loop while the guard keeps refusing');
});

test('Go Dark: a blocked remote connector reconnects when Go Dark goes off and drops when it comes back', async () => {
  const remote = await startHttpServer();
  let dark = true;
  /** @type {any} */
  const fetch = (input, init) => {
    const u = new URL(String(input));
    if (dark) return Promise.reject(new EgressBlockedError(u.host));
    return globalThis.fetch(`http://127.0.0.1:${remote.port}${u.pathname}`, init);
  };
  const { manager } = await newManager({ isGoDark: () => dark, fetch });
  const c = await manager.create({ name: 'Cloud', transport: 'http', url: 'https://mcp.example.com/mcp', bearerToken: TOKEN });
  assert.equal(c.status.error, GO_DARK_ERROR);
  dark = false;
  manager.list();
  assert.ok(await waitFor(() => manager.get(c.id).status.state === 'ready'));
  assert.equal(Object.keys(manager.agentTools()).length, 2);
  dark = true;
  assert.equal(manager.get(c.id).status.state, 'error');
  assert.equal(manager.get(c.id).status.error, GO_DARK_ERROR);
  assert.deepEqual(manager.agentTools(), {});
  await assert.rejects(manager.callTool(c.id, 'echo', { text: 'x' }), (err) => err.status === 400);
});

test('local URLs are not blocked by Go Dark', async () => {
  const remote = await startHttpServer();
  const { manager } = await newManager({ isGoDark: () => true });
  const c = await manager.create({ transport: 'http', url: remote.url, bearerToken: TOKEN });
  assert.equal(c.status.state, 'ready', c.status.error);
});

test('migration: http servers in mcp-servers.json become connectors, once', async () => {
  const remote = await startHttpServer();
  const dataDir = await tempDir();
  await fs.writeFile(path.join(dataDir, 'mcp-servers.json'), JSON.stringify({
    servers: [
      {
        id: 'old-1', name: 'Old Server', url: remote.url, transport: 'streamable-http', enabled: true, authToken: TOKEN,
        toolPolicy: { enforceAllowlist: true, requireApproval: true, approvalTtlSeconds: 300, allowedTools: ['echo'] }
      },
      {
        id: 'old-2', name: 'Open Server', url: remote.url, transport: 'streamable-http', enabled: true, authToken: TOKEN,
        toolPolicy: { enforceAllowlist: false, requireApproval: false, allowedTools: [] }
      },
      { id: 'bad', name: 'Broken', url: 'not a url', transport: 'streamable-http' }
    ]
  }));
  const { manager } = await newManager({ dataDir });
  const listed = manager.list();
  assert.deepEqual(listed.map((c) => [c.name, c.transport, c.headerKeys]), [
    ['Old Server', 'http', ['Authorization']],
    ['Open Server', 'http', ['Authorization']]
  ]);
  const [strict, open] = listed;
  assert.ok(await waitFor(() => manager.list().every((c) => c.status.state === 'ready')));
  assert.deepEqual(manager.get(strict.id).tools.map((t) => [t.name, t.permission]), [['echo', 'ask'], ['write_note', 'off']]);
  assert.deepEqual(manager.get(open.id).tools.map((t) => [t.name, t.permission]), [['echo', 'allow'], ['write_note', 'ask']]);

  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'connectors.json'), 'utf8')).connectors;
  assert.equal(stored[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(stored.every((r) => r.importRules === undefined), 'import rules are applied once and dropped');

  await manager.remove(strict.id);
  await manager.remove(open.id);
  await manager.shutdown();
  const { manager: again } = await newManager({ dataDir });
  assert.deepEqual(again.list(), [], 'the old file is imported only once');
});

test('a corrupt connectors.json recovers from .bak, or is moved aside', async () => {
  const dataDir = await tempDir();
  const file = path.join(dataDir, 'connectors.json');
  const saved = { id: 'c1', name: 'Saved', transport: 'stdio', command: process.execPath, args: [FAKE], enabled: false, tools: { echo: 'off' } };
  await fs.writeFile(file, '{ not json');
  await fs.writeFile(`${file}.bak`, JSON.stringify({ version: 1, connectors: [saved] }));
  const { manager } = await newManager({ dataDir });
  assert.deepEqual(manager.list().map((c) => [c.name, c.status.state]), [['Saved', 'off']]);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).connectors[0].tools.echo, 'off', 'rewritten from the backup');
  assert.equal(JSON.parse(await fs.readFile(`${file}.bak`, 'utf8')).connectors[0].name, 'Saved', 'the good backup is kept');

  const other = await tempDir();
  await fs.writeFile(path.join(other, 'connectors.json'), 'garbage');
  const { manager: fresh } = await newManager({ dataDir: other });
  assert.deepEqual(fresh.list(), []);
  assert.ok((await fs.readdir(other)).some((n) => n.startsWith('connectors.json.corrupt-')), 'the unreadable file is kept aside');
});

test('create validates input in plain words and saves nothing on a 400', async () => {
  const { manager } = await newManager();
  const nowhere = path.join(await tempDir(), 'missing');
  const cases = [
    [{ name: 'x'.repeat(61), command: 'node' }, /60 characters/],
    [{ transport: 'stdio' }, /command that starts/],
    [{ transport: 'http', url: 'ftp://host/mcp' }, /http:\/\/ or https:\/\//],
    [{ transport: 'http', url: 'nope' }, /http:\/\/ or https:\/\//],
    [{ transport: 'pigeon', command: 'x' }, /Transport must be/],
    [{}, /local command or a remote URL/],
    [{ command: 'node', env: { 'BAD KEY': 'x' } }, /Not a valid variable name/],
    [{ command: 'node', env: 'NOEQUALS' }, /KEY=value/],
    [{ command: 'node', cwd: nowhere }, /Working folder not found/],
    [{ transport: 'http', url: 'http://localhost/mcp', headers: { 'X-A': 'a\r\nb' } }, /line break/],
    [{ presetId: 'nope' }, /Unknown catalog entry/],
    [{ presetId: 'filesystem', fields: {} }, /Folders is required/],
    [{ presetId: 'filesystem', fields: { folders: [nowhere] } }, /Not found/],
    [{ command: 'node', enabled: 'no' }, /true or false/]
  ];
  for (const [input, message] of cases) {
    await assert.rejects(manager.create(input), (err) => err.status === 400 && message.test(err.message), JSON.stringify(input));
  }
  assert.deepEqual(manager.list(), []);
});

test('a command typed with its arguments is split', async () => {
  const { manager } = await newManager();
  const c = await manager.create({ command: `"${process.execPath}" ${FAKE}`, enabled: false });
  assert.equal(c.command, process.execPath);
  assert.deepEqual(c.args, [FAKE]);
  assert.equal(c.name, 'fakeMcpServer');
});

test('catalog presets fill their fields and check folders, repositories and files', async () => {
  const { manager, dataDir } = await newManager();
  const dir = await tempDir('mirabilis-preset-');
  const files = await manager.create({ presetId: 'filesystem', fields: { folders: `${dir}\n${dir}` }, enabled: false });
  assert.equal(files.name, 'Filesystem');
  assert.equal(files.preset, 'filesystem');
  assert.equal(files.command, 'npx');
  assert.deepEqual(files.args, ['-y', '@modelcontextprotocol/server-filesystem', dir, dir]);
  assert.equal(files.status.state, 'off');
  assert.equal((await manager.create({ presetId: 'filesystem', fields: { folders: [dir] }, enabled: false })).name, 'Filesystem 2');

  await assert.rejects(manager.create({ presetId: 'git', fields: { repo: dir } }), /Not a git repository/);
  await fs.mkdir(path.join(dir, '.git'));
  const git = await manager.create({ presetId: 'git', fields: { repo: dir }, enabled: false });
  assert.deepEqual([git.command, ...git.args], ['uvx', 'mcp-server-git', '--repository', dir]);

  const script = path.join(dir, 'jmcp.py');
  const devices = path.join(dir, 'devices.json');
  await assert.rejects(manager.create({ presetId: 'junos', fields: { folder: dir } }), /jmcp\.py not found in/);
  await fs.writeFile(script, '');
  await assert.rejects(manager.create({ presetId: 'junos', fields: { folder: script } }), /Server folder not found/);
  await assert.rejects(manager.create({ presetId: 'junos', fields: { folder: dir } }), /Devices file not found/);
  await fs.writeFile(devices, '{}');
  // preset is accepted as well as presetId.
  const junos = await manager.create({ preset: 'junos', fields: { folder: dir }, enabled: false });
  const python = process.platform === 'win32' ? 'python' : 'python3';
  assert.deepEqual([junos.command, ...junos.args], [python, script, '-f', devices, '-t', 'stdio']);
  assert.equal(junos.cwd, dir, 'runs from the server folder');
  assert.equal(junos.preset, 'junos');

  const memory = await manager.create({ presetId: 'memory', enabled: false });
  assert.deepEqual(memory.envKeys, ['MEMORY_FILE_PATH']);
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'connectors.json'), 'utf8')).connectors.find((r) => r.id === memory.id);
  assert.equal(stored.env.MEMORY_FILE_PATH, `${dataDir}/connector-memory.jsonl`, 'memory lives in the data folder, not the npx cache');
});

test('catalog: availability follows the launchers on PATH', { skip: process.platform === 'win32' }, async () => {
  const bin = await tempDir('mirabilis-bin-');
  await fs.writeFile(path.join(bin, 'npx'), '#!/bin/sh\n', { mode: 0o755 });
  // An empty home, so a Junos server in the real one cannot make it available.
  const presets = buildCatalog({ pathValue: bin, platform: 'darwin', home: await tempDir('mirabilis-home-') });
  assert.deepEqual(presets.map((p) => p.id), ['filesystem', 'memory', 'sequential-thinking', 'git', 'fetch', 'time', 'junos', 'everything']);
  for (const p of presets) {
    assert.equal(p.available, p.requires === 'npx', p.id);
    assert.equal(p.installHint === '', p.available, p.id);
    assert.equal(p.transport, 'stdio');
    assert.ok(['Files', 'Developer', 'Network', 'Knowledge', 'Utilities'].includes(p.category), p.id);
    assert.ok(p.docsUrl.startsWith('https://'), p.id);
    for (const f of p.fields) assert.deepEqual(Object.keys(f), ['key', 'label', 'kind', 'placeholder', 'required']);
  }
  const byId = Object.fromEntries(presets.map((p) => [p.id, p]));
  assert.equal(byId.fetch.network, true);
  assert.match(byId.fetch.installHint, /brew install uv/);
  assert.equal(byId.junos.category, 'Network');
  assert.equal(byId.junos.docsUrl, 'https://github.com/Juniper/junos-mcp-server');
  assert.deepEqual(byId.junos.args, ['{folder}/jmcp.py', '-f', '{devices}', '-t', 'stdio']);
  assert.equal(byId.everything.category, 'Developer');
  assert.equal(byId.everything.note, '');

  const { manager } = await newManager({ env: { PATH: bin, HOME: os.homedir() } });
  const fromManager = manager.catalog();
  assert.equal(fromManager.length, 8);
  assert.ok(fromManager.filter((p) => p.requires === 'npx').every((p) => p.available), 'npx found on the given PATH');
});

test('Junos from its folder: the venv python runs it, and it starts and stops with the manager', { skip: process.platform === 'win32' }, async () => {
  const dir = await tempDir('mirabilis-junos-');
  await fs.writeFile(path.join(dir, 'jmcp.py'), '');
  await fs.writeFile(path.join(dir, 'devices.json'), '{}');
  await fs.mkdir(path.join(dir, '.venv', 'bin'), { recursive: true });
  // Stands in for the venv python: runs the fake server, whatever it is given.
  await fs.writeFile(path.join(dir, '.venv', 'bin', 'python'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}"\n`, { mode: 0o755 });
  const dataDir = await tempDir();
  const first = createConnectorManager({ dataDir, builtins: [] });
  managers.push(first);
  await first.init();
  const c = await first.create({ preset: 'junos', fields: { folder: dir } });
  assert.equal(c.status.state, 'ready', c.status.error);
  assert.equal(c.command, path.join(dir, '.venv', 'bin', 'python'));
  assert.deepEqual(c.args, [path.join(dir, 'jmcp.py'), '-f', path.join(dir, 'devices.json'), '-t', 'stdio']);
  assert.equal(c.cwd, dir);
  assert.equal(c.tools.length, 2);
  const pid = c.status.pid;
  await first.shutdown();
  assert.ok(gone(pid), 'it stops with the backend');

  const { manager } = await newManager({ dataDir });
  assert.ok(await waitFor(() => manager.get(c.id)?.status.state === 'ready'), 'it starts with the backend');
});

test('a Junos connector saved before the folder field still runs as saved', async () => {
  const dataDir = await tempDir();
  const dir = await tempDir('mirabilis-old-junos-');
  // The old preset stored the script and devices paths and ran from the script's folder.
  const old = {
    id: 'old-junos', name: 'Junos', transport: 'stdio', command: process.execPath,
    args: [FAKE, '-f', path.join(dir, 'devices.json'), '-t', 'stdio'], cwd: dir, enabled: true, preset: 'junos', tools: {}
  };
  await fs.writeFile(path.join(dataDir, 'connectors.json'), JSON.stringify({ version: 1, connectors: [old] }));
  const { manager } = await newManager({ dataDir });
  assert.ok(await waitFor(() => manager.get('old-junos')?.status.state === 'ready'), manager.get('old-junos')?.status.error || '');
  const c = manager.get('old-junos');
  assert.deepEqual([c.command, c.args, c.cwd, c.preset], [old.command, old.args, old.cwd, 'junos']);
});

// This computer

/** @param {any} manager */
const builtinReady = (manager) => waitFor(() => manager.get(THIS_COMPUTER_ID)?.status.state === 'ready');

test('This computer runs machineServer.js on this runtime as Node, from home, with the operator jail when set', () => {
  assert.deepEqual(thisComputerConnector({ dataDir: 'data', env: {} }).spawn(), {
    command: process.execPath,
    args: [fileURLToPath(new URL('./machineServer.js', import.meta.url))],
    env: { ELECTRON_RUN_AS_NODE: '1', MIRABILIS_DATA_DIR: path.resolve('data') },
    cwd: os.homedir()
  });
  const jailed = thisComputerConnector({ dataDir: 'data', env: { MIRABILIS_MCP_FS_ROOT: 'jail' } }).spawn();
  assert.equal(jailed.env.MIRABILIS_MCP_FS_ROOT, path.resolve('jail'));
});

test('This computer: on by default and listed first, started as Node with the data folder, tools offered to agents', async () => {
  const dataDir = await tempDir();
  const file = path.join(dataDir, 'connectors.json');
  // Saved before the built-in existed; it must come through exactly as it was.
  const custom = {
    id: 'c1', name: 'Saved', transport: 'stdio', command: process.execPath, args: [FAKE], env: { FAKE_MCP_SECRET: SECRET },
    cwd: '', url: '', headers: {}, enabled: false, tools: { echo: 'off' }, toolInfo: {}, preset: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z'
  };
  await fs.writeFile(file, JSON.stringify({ version: 1, connectors: [custom] }));
  const probe = await envProbe();
  const { manager } = await newManager({
    dataDir,
    env: { ...process.env, OPENAI_API_KEY: 'sk-backend-secret-000000000000' },
    builtins: [thisComputerConnector({ dataDir, script: probe })]
  });
  assert.deepEqual(manager.list().map((c) => [c.id, c.name, c.builtin, c.enabled]), [
    [THIS_COMPUTER_ID, 'This computer', true, true],
    ['c1', 'Saved', false, false]
  ]);
  assert.ok(await builtinReady(manager), manager.get(THIS_COMPUTER_ID).status.error || 'not ready');
  const c = manager.get(THIS_COMPUTER_ID);
  assert.deepEqual([c.transport, c.command, c.args, c.cwd, c.envKeys, c.hasSecrets, c.preset], ['stdio', '', [], '', [], false, null]);
  assert.deepEqual(c.tools.map((t) => [t.name, t.permission]), [['echo', 'allow'], ['write_note', 'ask']]);

  assert.ok(manager.logs(THIS_COMPUTER_ID).includes(`[mirabilis] Starting ${process.execPath} ${probe}`), 'run by this runtime');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'probe.json'), 'utf8')), {
    electronRunAsNode: '1',
    dataDir,
    cwd: await fs.realpath(os.homedir()),
    openAiKey: null
  });

  const tools = manager.agentTools();
  assert.deepEqual(Object.keys(tools).sort(), ['this_computer__echo', 'this_computer__write_note']);
  assert.equal(tools.this_computer__echo.connectorId, THIS_COMPUTER_ID);
  assert.equal(tools.this_computer__echo.description, 'Returns the text it is given. (connector: This computer)');
  assert.deepEqual(await tools.this_computer__echo.execute({ text: 'from this computer' }), { text: 'from this computer' });

  const stored = JSON.parse(await fs.readFile(file, 'utf8')).connectors;
  assert.deepEqual(stored.map((r) => r.id), [THIS_COMPUTER_ID, 'c1']);
  assert.deepEqual(Object.keys(stored[0]).sort(), ['enabled', 'id', 'toolInfo', 'tools'], 'only the switch and permissions are saved');
  assert.deepEqual(stored[0].tools, { echo: 'allow', write_note: 'ask' });
  assert.deepEqual(stored[1], custom);
});

test('This computer: a stale saved command is ignored, and switched off it stops and stays off', async () => {
  const dataDir = await tempDir();
  const file = path.join(dataDir, 'connectors.json');
  // An older or edited file: only the switch and the permissions may count.
  await fs.writeFile(file, JSON.stringify({ version: 1, connectors: [{
    id: THIS_COMPUTER_ID, name: 'Renamed', transport: 'stdio', command: 'mirabilis-no-such-command-xyz', args: ['--stale'],
    env: { STALE_KEY: 'stale-secret-value' }, cwd: path.join(dataDir, 'missing'), enabled: true, tools: { write_note: 'off' }
  }] }));
  const builtins = [thisComputerConnector({ dataDir, script: FAKE })];
  const { manager } = await newManager({ dataDir, builtins });
  assert.ok(await builtinReady(manager), manager.get(THIS_COMPUTER_ID).status.error || 'not ready');
  const c = manager.get(THIS_COMPUTER_ID);
  assert.deepEqual([c.name, c.command, c.args, c.cwd, c.envKeys], ['This computer', '', [], '', []]);
  assert.ok(manager.logs(THIS_COMPUTER_ID).includes(`[mirabilis] Starting ${process.execPath} ${FAKE}`), manager.logs(THIS_COMPUTER_ID).join('\n'));
  assert.equal(c.tools.find((t) => t.name === 'write_note').permission, 'off', 'saved permissions apply');
  assert.deepEqual(Object.keys(manager.agentTools()), ['this_computer__echo']);
  const saved = JSON.parse(await fs.readFile(file, 'utf8')).connectors;
  assert.deepEqual(saved, [{
    id: THIS_COMPUTER_ID,
    enabled: true,
    tools: { write_note: 'off', echo: 'allow' },
    toolInfo: {
      echo: { title: 'Echo', description: 'Returns the text it is given.', readOnly: true },
      write_note: { title: 'write_note', description: 'Saves a note.', readOnly: false }
    }
  }], 'the next save drops the stale fields');

  const pid = c.status.pid;
  const off = await manager.update(THIS_COMPUTER_ID, { enabled: false });
  assert.equal(off.status.state, 'off');
  assert.ok(gone(pid), 'switching it off stops the program');
  assert.deepEqual(manager.agentTools(), {});
  await manager.shutdown();

  const { manager: again } = await newManager({ dataDir, builtins });
  assert.deepEqual(again.list().map((x) => [x.id, x.enabled, x.status.state]), [[THIS_COMPUTER_ID, false, 'off']]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(again.get(THIS_COMPUTER_ID).status.pid, null, 'it does not start while off');
  assert.equal(again.get(THIS_COMPUTER_ID).tools.length, 2, 'it still lists its tools');
  const on = await again.update(THIS_COMPUTER_ID, { enabled: true });
  assert.equal(on.status.state, 'ready', on.status.error);
});

test('This computer cannot be removed, and only its switch and tool permissions change', async () => {
  const dataDir = await tempDir();
  const def = thisComputerConnector({ dataDir, script: FAKE });
  let spawns = 0;
  const counted = { ...def, spawn: () => { spawns += 1; return def.spawn(); } };
  const { manager } = await newManager({ dataDir, builtins: [counted] });
  assert.ok(await builtinReady(manager), manager.get(THIS_COMPUTER_ID).status.error || 'not ready');
  const created = JSON.parse(await fs.readFile(path.join(dataDir, 'connectors.json'), 'utf8')).connectors;
  assert.deepEqual(created.map((r) => [r.id, r.enabled]), [[THIS_COMPUTER_ID, true]], 'a fresh data folder gets it, on');
  await assert.rejects(manager.remove(THIS_COMPUTER_ID),
    (err) => err.status === 400 && err.message === 'Built-in connectors cannot be removed. Switch it off.');
  const patches = [
    { name: 'Mine' }, { command: 'node' }, { args: ['x'] }, { env: { A: '1' } }, { cwd: os.homedir() },
    { url: 'http://localhost/mcp' }, { headers: { A: 'b' } }, { transport: 'stdio' }, { enabled: false, name: 'This computer' }
  ];
  for (const patch of patches) {
    await assert.rejects(manager.update(THIS_COMPUTER_ID, patch),
      (err) => err.status === 400 && err.message === 'Only on/off and tool permissions can change here.', JSON.stringify(patch));
  }
  const changed = await manager.update(THIS_COMPUTER_ID, { tools: { echo: 'ask' } });
  assert.equal(changed.tools.find((t) => t.name === 'echo').permission, 'ask');
  assert.equal(changed.status.state, 'ready', 'a refused change stopped nothing');
  assert.equal((await manager.restart(THIS_COMPUTER_ID)).status.state, 'ready');
  assert.equal(spawns, 2, 'what it runs is worked out at every start');

  // Its name is taken, so its agent tool names stay its own.
  const twin = await manager.create(fakeStdio({ name: 'This computer', enabled: false }));
  assert.deepEqual([twin.name, twin.builtin], ['This computer 2', false]);
  assert.deepEqual(manager.list().map((x) => x.id), [THIS_COMPUTER_ID, twin.id], 'the built-in stays first');
});

test('slug and toolKey make safe, bounded agent tool names', () => {
  assert.equal(slug('My Fake Server!'), 'my_fake_server');
  assert.equal(slug('a__b--c'), 'a_b_c');
  assert.equal(slug(''), 'x');
  assert.equal(toolKey('Git', 'git_status'), 'git__git_status');
  const long = toolKey('A very long connector name that keeps going and going', 'an_equally_long_tool_name_that_also_keeps_going');
  assert.ok(long.length <= 60, long);
  assert.match(long, /^[a-z0-9_]+__[a-z0-9_]+$/);
  assert.ok(toolKey('c', 'x'.repeat(90)).length <= 60);
});

test('formatToolResult joins text and notes everything else', () => {
  const r = formatToolResult({
    content: [
      { type: 'text', text: 'a' },
      { type: 'image', data: 'x', mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'file:///x', text: 'body' } },
      { type: 'resource', resource: { uri: 'file:///bin', blob: 'AA==' } },
      { type: 'audio', data: 'x' }
    ],
    isError: true
  });
  assert.equal(r.text, 'a\n[image]\n[resource: file:///x]\nbody\n[resource: file:///bin]\n[audio]');
  assert.equal(r.isError, true);
  assert.equal(formatToolResult({ content: [], structuredContent: { ok: 1 } }).text, '{"ok":1}');
  assert.equal(formatToolResult(null).text, '');
});

test('describeParameters marks required and reads enums, arrays and unions', () => {
  assert.deepEqual(describeParameters({
    type: 'object',
    properties: {
      mode: { enum: ['a', 'b'] },
      paths: { type: 'array', items: { type: 'string' }, description: 'Files to read' },
      n: { anyOf: [{ type: 'number' }, { type: 'null' }] }
    },
    required: ['mode']
  }), {
    mode: 'one of "a", "b" (required)',
    paths: 'array of string (optional, Files to read)',
    n: 'number or null (optional)'
  });
  assert.deepEqual(describeParameters(undefined), {});
});
