// Runs the built-in This computer MCP server the way the app does, over stdio, and calls
// every tool for real. Each OS answers with its own commands (log show, journalctl,
// Get-WinEvent, launchctl, systemctl, CIM, ping, du), so only a run on each one proves them.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'backend', 'src', 'mcp', 'machineServer.js');
const EXPECTED_TOOLS = [
  'system_overview', 'list_processes', 'network_overview', 'read_log', 'disk_usage', 'system_logs',
  'services', 'startup_items', 'hardware_info', 'ping_host', 'dns_lookup', 'check_port', 'kill_process'
];
const RESULT_BUDGET = 3_500;
const ESCAPED_BUDGET = 3_900;

// A data folder, a log, a folder to measure and a port that is open.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mirabilis-machine-smoke-'));
const logFile = path.join(tmp, 'smoke.log');
writeFileSync(logFile, `${Array.from({ length: 50 }, (_, i) => `line ${i + 1} smoke`).join('\n')}\nlast line smoke\n`);
const filled = path.join(tmp, 'filled');
mkdirSync(path.join(filled, 'big-folder'), { recursive: true });
writeFileSync(path.join(filled, 'big-folder', 'blob.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
writeFileSync(path.join(filled, 'small.txt'), 'small\n');
const listener = net.createServer((socket) => socket.destroy());
await new Promise((resolve) => listener.listen(0, '127.0.0.1', () => resolve(undefined)));
const port = /** @type {net.AddressInfo} */ (listener.address()).port;

const server = spawn(process.execPath, [SERVER], {
  cwd: os.homedir(),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MIRABILIS_DATA_DIR: tmp },
  stdio: ['pipe', 'pipe', 'pipe']
});
let exitCode = null;
const exited = new Promise((resolve) => server.once('exit', (code, signal) => { exitCode = code ?? signal; resolve(undefined); }));
const stderr = [];
server.stderr.setEncoding('utf8');
server.stderr.on('data', (chunk) => stderr.push(chunk));

const pending = new Map();
const badLines = [];
let buffer = '';
server.stdout.setEncoding('utf8');
server.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).replace(/\r$/, '');
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { badLines.push(line); continue; }
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});

let nextId = 1;
function request(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} got no answer in ${timeoutMs / 1000}s`)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const failures = [];
const rows = [];
/** The promise's value, or `fallback` after ms; the timer never outlives the race. */
function within(promise, ms, fallback) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })])
    .finally(() => clearTimeout(timer));
}

function check(name, ok, detail) {
  if (!ok) failures.push(`${name}: ${detail}`);
  return ok;
}

// The whole run is bounded, so a hang shows as a failure with output, not a stuck job.
const watchdog = setTimeout(() => {
  console.error('Smoke machine MCP FAILED: no finish within 4 minutes.');
  console.error(stderr.join('').slice(-2000));
  server.kill('SIGKILL');
  process.exit(1);
}, 4 * 60 * 1000);

try {
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  check('initialize', init.result?.protocolVersion === '2025-06-18' && init.result?.serverInfo?.name === 'mirabilis-machine'
    && init.result?.capabilities?.tools, JSON.stringify(init).slice(0, 300));
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const list = await request('tools/list', {});
  const tools = list.result?.tools || [];
  const names = tools.map((t) => t.name).sort();
  check('tools/list', JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort()), `got ${names.join(', ')}`);
  for (const t of tools) {
    const a = t.annotations || {};
    if (t.name === 'kill_process') check(t.name, a.readOnlyHint === false && a.destructiveHint === true, 'must be marked destructive');
    else check(t.name, a.readOnlyHint === true, 'must be marked read-only');
    if (['ping_host', 'dns_lookup', 'check_port'].includes(t.name)) check(t.name, a.openWorldHint === true, 'must be marked open world');
  }

  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const sleeperGone = new Promise((resolve) => sleeper.once('exit', () => resolve(true)));

  /** Safe arguments for every tool, and what a good answer must show. */
  const calls = [
    ['system_overview', {}, (r) => typeof r.os === 'string' && r.memory?.totalGB > 0],
    ['list_processes', { limit: 5 }, (r) => r.processes?.length > 0 && r.processes.length <= 5],
    ['network_overview', {}, (r) => Array.isArray(r.interfaces) && Array.isArray(r.listening)],
    ['read_log', { path: logFile, lines: 20 }, (r) => /last line smoke$/.test(r.text) && r.shown === 20],
    ['disk_usage', { path: filled, limit: 5 }, (r) => r.entries?.[0]?.name === 'big-folder' && r.entries.some((e) => e.name === 'small.txt')],
    ['system_logs', { minutes: 5, limit: 5 }, (r) => Array.isArray(r.entries) && r.entries.length <= 5 && typeof r.matched === 'number'],
    ['services', { limit: 5 }, (r) => r.total > 0 && r.services?.length > 0 && r.services.length <= 5],
    ['startup_items', {}, (r) => r && typeof r === 'object'],
    ['hardware_info', {}, (r) => Boolean(r.cpu?.name) && Boolean(r.memory?.total)],
    ['ping_host', { host: '127.0.0.1', count: 1 }, (r) => r.sent === 1 && r.received === 1],
    ['dns_lookup', { name: 'localhost' }, (r) => Array.isArray(r.system) && r.system.some((a) => a === '127.0.0.1' || a === '::1')],
    ['check_port', { host: '127.0.0.1', port }, (r) => r.state === 'open'],
    ['kill_process', { pid: sleeper.pid }, (r) => r.exited === true && r.pid === sleeper.pid]
  ];

  for (const [name, args, good] of calls) {
    const started = Date.now();
    let msg;
    try {
      msg = await request('tools/call', { name, arguments: args });
    } catch (err) {
      check(name, false, err.message);
      rows.push([name, 'FAIL', '-', `${Date.now() - started}ms`]);
      continue;
    }
    const ms = `${Date.now() - started}ms`;
    const text = String(msg.result?.content?.[0]?.text ?? '');
    const size = `${text.length} chars`;
    if (msg.error) {
      check(name, false, `JSON-RPC error ${msg.error.code}: ${msg.error.message}`);
      rows.push([name, 'FAIL', size, ms]);
      continue;
    }
    if (msg.result?.isError) {
      // A facility this OS lacks is an answer; anything else is a failure.
      const unavailable = /not available on this system/i.test(text);
      check(name, unavailable, text);
      rows.push([name, unavailable ? 'n/a' : 'FAIL', size, ms]);
      if (unavailable) console.log(`  ${name}: ${text}`);
      continue;
    }
    let value = null;
    try { value = JSON.parse(text); } catch { /* reported below */ }
    const fits = text.length <= RESULT_BUDGET && JSON.stringify(text).length <= ESCAPED_BUDGET;
    const ok = check(name, value !== null, `not JSON: ${text.slice(0, 200)}`)
      && check(name, fits, `${text.length} characters is over the result budget`)
      && check(name, good(value), `unexpected answer: ${text.slice(0, 400)}`);
    rows.push([name, ok ? 'ok' : 'FAIL', size, ms]);
  }

  const gone = await within(sleeperGone, 5000, false);
  check('kill_process', gone === true, 'the sleeping process is still running');
  if (gone !== true) sleeper.kill('SIGKILL');

  check('stdout', badLines.length === 0, `non-protocol output: ${badLines.slice(0, 3).join(' | ')}`);

  // stdin closed: the server must exit on its own, cleanly.
  server.stdin.end();
  const stopped = await within(exited.then(() => true), 5000, false);
  check('shutdown', stopped && exitCode === 0, stopped ? `exit code ${exitCode}` : 'still running 5s after stdin closed');
} catch (err) {
  failures.push(`run: ${err?.stack || err}`);
} finally {
  clearTimeout(watchdog);
  if (exitCode === null) server.kill('SIGKILL');
  listener.close();
  rmSync(tmp, { recursive: true, force: true });
}

const width = Math.max(...rows.map((r) => r[0].length), 4);
console.log(`\nThis computer MCP server on ${process.platform} (${os.release()}), Node ${process.version}`);
for (const [name, status, size, ms] of rows) {
  console.log(`  ${name.padEnd(width)}  ${status.padEnd(4)}  ${size.padStart(11)}  ${ms.padStart(7)}`);
}
if (failures.length) {
  console.error(`\nSmoke machine MCP FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  ${f}`);
  const tail = stderr.join('').trim().split('\n').slice(-20).join('\n');
  if (tail) console.error(`\nServer stderr:\n${tail}`);
  process.exit(1);
}
console.log('\nSmoke machine MCP: every tool answered.');
