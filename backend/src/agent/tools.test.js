// Tool registry: what each Access level offers, the approval gate, edit_file, pre-write
// copies, and the shell runner's bounds.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { createToolRegistry, createRunRules, backupName, pruneRunBackups, runBackupDir } from './tools.js';
import { createApprovalBroker } from './approvals.js';
import { isSafeCommand, safeResolvePath } from './sandbox.js';

async function sandboxDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-agent-'));
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello\nworld\nneedle here\n', 'utf8');
  await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
  await fs.writeFile(path.join(dir, 'sub', 'b.js'), 'const x = 1; // needle\n', 'utf8');
  return dir;
}

/**
 * A real broker that answers every request with `decision`, recording what it was asked.
 * @param {'allow'|'always'|'deny'} decision
 */
function answeringBroker(decision, note) {
  const requests = [];
  const broker = createApprovalBroker({
    emit: (type, payload) => {
      if (type !== 'approval-required') return;
      requests.push(payload);
      setImmediate(() => broker.resolve(payload.approvalId, decision, note));
    }
  });
  return { broker, requests };
}

const exists = (p) => fs.stat(p).then(() => true, () => false);

// what each level offers

test('read is the default level and offers every built-in tool', () => {
  const r = createToolRegistry();
  assert.equal(r.level, 'read');
  for (const name of ['list_dir', 'read_file', 'search_files', 'write_file', 'edit_file', 'run_command']) {
    assert.ok(r.has(name), `${name} should be offered`);
  }
});

test('chat only offers nothing and refuses every call', async () => {
  const r = createToolRegistry({ level: 'chat' });
  assert.deepEqual(r.names(), []);
  assert.equal(r.describeForPrompt(), '');
  const res = await r.dispatch('read_file', { path: '/etc/hosts' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Chat only/);
  assert.equal(r.addTool('spawn_agents', { kind: 'internal', description: 'x', parameters: {}, execute: async () => ({}) }), false,
    'spawn_agents is never offered in Chat only');
});

test('an unknown level falls back to chat rather than opening up', async () => {
  const r = createToolRegistry({ level: 'superuser' });
  assert.equal(r.level, 'chat');
  assert.equal((await r.dispatch('run_command', { command: 'echo hi' })).ok, false);
});

test('an unknown tool name is reported, not thrown', async () => {
  const res = await createToolRegistry().dispatch('rm_minus_rf', {});
  assert.equal(res.ok, false);
  assert.match(res.error, /Unknown tool/);
});

// the read tools

test('list_dir and read_file work inside the jail', async () => {
  const dir = await sandboxDir();
  const r = createToolRegistry({ fsRoot: dir });

  const ls = await r.dispatch('list_dir', { path: '.' });
  assert.equal(ls.ok, true);
  assert.deepEqual(ls.result.entries.map((e) => e.name).sort(), ['a.txt', 'sub']);

  const rd = await r.dispatch('read_file', { path: 'a.txt' });
  assert.equal(rd.ok, true);
  assert.match(rd.result.text, /needle here/);
});

test('read_file honours a line range', async () => {
  const dir = await sandboxDir();
  const r = createToolRegistry({ fsRoot: dir });
  const rd = await r.dispatch('read_file', { path: 'a.txt', startLine: 2, endLine: 2 });
  assert.equal(rd.result.text.trim(), 'world');
});

test('search_files finds matches and reports a clean miss as zero, not an error', async () => {
  const dir = await sandboxDir();
  const r = createToolRegistry({ fsRoot: dir });

  const hit = await r.dispatch('search_files', { pattern: 'needle', path: '.' });
  assert.equal(hit.ok, true);
  assert.ok(hit.result.matchCount >= 2, `expected matches in both files, got ${hit.result.matchCount}`);

  const miss = await r.dispatch('search_files', { pattern: 'zzz-not-present-zzz', path: '.' });
  assert.equal(miss.ok, true, 'grep exiting 1 is an answer, not a failure');
  assert.equal(miss.result.matchCount, 0);
});

test('large output is truncated so one tool call cannot eat the context', async () => {
  const dir = await sandboxDir();
  await fs.writeFile(path.join(dir, 'big.txt'), 'x'.repeat(50_000), 'utf8');
  const r = createToolRegistry({ fsRoot: dir });
  const rd = await r.dispatch('read_file', { path: 'big.txt' });
  assert.equal(rd.result.truncated, true);
  assert.ok(rd.result.text.length <= 12_000);
  assert.match(rd.result.note, /truncated/);
});

test('search honours the glob and skips dependency folders', async () => {
  const dir = await sandboxDir();
  await fs.mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules', 'x', 'a.js'), 'needle');
  await fs.writeFile(path.join(dir, 'b.rs'), 'needle');
  await fs.writeFile(path.join(dir, 'c.js'), 'needle');
  const r = createToolRegistry({ fsRoot: dir, workDir: dir });
  const res = await r.dispatch('search_files', { pattern: 'needle', path: '.', glob: '*.rs' });
  assert.equal(res.result.matchCount, 1);
  assert.match(res.result.matches[0], /b\.rs/);
});

// paths

test('relative paths start at the project folder and ~ is the home folder', async () => {
  const dir = await sandboxDir();
  const r = createToolRegistry({ workDir: dir });
  assert.equal((await r.dispatch('read_file', { path: 'a.txt' })).ok, true);
  const home = await r.dispatch('list_dir', { path: '~' });
  assert.equal(home.result.path, os.homedir());
});

test('without a project folder, relative paths start at home', async () => {
  const r = createToolRegistry();
  const res = await r.dispatch('list_dir', { path: '.' });
  assert.equal(res.result.path, os.homedir());
});

test('there is no folder jail: an absolute path outside the project folder is readable', async () => {
  const project = await sandboxDir();
  const other = await sandboxDir();
  const r = createToolRegistry({ workDir: project });
  const res = await r.dispatch('read_file', { path: path.join(other, 'a.txt') });
  assert.equal(res.ok, true);
  assert.match(res.result.text, /hello/);
});

test('the operator jail refuses paths that escape it', async () => {
  const dir = await sandboxDir();
  const r = createToolRegistry({ fsRoot: dir });
  for (const escape of ['../../../../etc/passwd', '/etc/passwd', 'sub/../../../..']) {
    const res = await r.dispatch('read_file', { path: escape });
    assert.equal(res.ok, false, `${escape} must be refused`);
    assert.match(res.error, /escapes the permitted filesystem root|not a file|ENOENT/);
  }
});

test('the operator jail holds in Bypass too', async () => {
  const dir = await sandboxDir();
  const r = createToolRegistry({ level: 'bypass', fsRoot: dir });
  const res = await r.dispatch('write_file', { path: '/etc/mirabilis-should-not-exist', content: 'x' });
  assert.equal(res.ok, false);
  assert.match(res.error, /escapes the permitted filesystem root/);
});

test('safeResolvePath rejects traversal and NUL bytes', () => {
  const root = '/tmp/mirabilis-jail-test';
  assert.throws(() => safeResolvePath('../escape', root), /escapes/);
  const ok = safeResolvePath('inside/file.txt', root);
  assert.ok(ok.startsWith(root));
  assert.ok(!safeResolvePath('a\0b', root).includes('\0'));
});

// Read only

test('Read only runs read-only commands and refuses the rest without asking', async () => {
  const dir = await sandboxDir();
  const { broker, requests } = answeringBroker('allow');
  const r = createToolRegistry({ level: 'read', workDir: dir, gate: { broker } });

  const ok = await r.dispatch('run_command', { command: 'ls -la' });
  assert.equal(ok.ok, true);
  assert.match(ok.result.stdout, /a\.txt/);

  const touch = await r.dispatch('run_command', { command: 'touch made.txt' });
  assert.equal(touch.ok, false);
  assert.match(touch.error, /Read only: this command may change things/);

  const write = await r.dispatch('write_file', { path: 'new.txt', content: 'x' });
  assert.equal(write.ok, false);
  assert.match(write.error, /Read only: changing files is off/);

  assert.equal(requests.length, 0, 'Read only never asks');
  assert.equal(await exists(path.join(dir, 'made.txt')), false);
  assert.equal(await exists(path.join(dir, 'new.txt')), false);
});

// Ask first

test('Ask first runs read-only commands freely and asks before anything else', async () => {
  const dir = await sandboxDir();
  const { broker, requests } = answeringBroker('allow');
  const r = createToolRegistry({ level: 'ask', workDir: dir, gate: { broker } });

  assert.equal((await r.dispatch('run_command', { command: 'cat a.txt | grep needle' })).ok, true);
  assert.equal(requests.length, 0, 'a read-only pipeline needs no approval');

  const res = await r.dispatch('run_command', { command: 'touch made.txt' }, { iteration: 3 });
  assert.equal(res.ok, true);
  assert.equal(requests.length, 1);
  const req = requests[0];
  assert.equal(req.kind, 'command');
  assert.equal(req.title, 'Run a command');
  assert.equal(req.detail, 'touch made.txt');
  assert.equal(req.alwaysLabel, 'Always allow `touch`');
  assert.equal(req.tool, 'run_command');
  assert.equal(req.iteration, 3);
  assert.equal(req.cwd, dir);
  assert.ok(req.approvalId);
  assert.equal(await exists(path.join(dir, 'made.txt')), true);
});

test('a denial reaches the caller with the user\'s note, and nothing runs', async () => {
  const dir = await sandboxDir();
  const { broker } = answeringBroker('deny', 'not on my laptop');
  const r = createToolRegistry({ level: 'ask', workDir: dir, gate: { broker } });
  const res = await r.dispatch('write_file', { path: 'new.txt', content: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'The user denied this action. Note: not on my laptop');
  assert.equal(await exists(path.join(dir, 'new.txt')), false);

  const plain = answeringBroker('deny');
  const r2 = createToolRegistry({ level: 'ask', workDir: dir, gate: { broker: plain.broker } });
  assert.equal((await r2.dispatch('write_file', { path: 'new.txt', content: 'x' })).error, 'The user denied this action.');
});

test('Always allow for a command saves the rule and skips the next ask', async () => {
  const dir = await sandboxDir();
  const { broker, requests } = answeringBroker('always');
  const saved = [];
  const runRules = createRunRules();
  const r = createToolRegistry({
    level: 'ask', workDir: dir,
    gate: { broker, runRules, persistAllowCommand: (rule) => { saved.push(rule); } }
  });
  assert.equal((await r.dispatch('run_command', { command: 'touch one.txt' })).ok, true);
  assert.deepEqual(saved, ['touch']);
  assert.deepEqual(runRules.commandRules, ['touch']);

  assert.equal((await r.dispatch('run_command', { command: 'touch two.txt' })).ok, true);
  assert.equal(requests.length, 1, 'the rule covers the second touch');
});

test('saved allowCommands apply in Ask first only, never in Read only', async () => {
  const dir = await sandboxDir();
  const { broker, requests } = answeringBroker('deny');
  const gate = { broker, allowCommands: () => ['touch'] };
  const ask = createToolRegistry({ level: 'ask', workDir: dir, gate });
  assert.equal((await ask.dispatch('run_command', { command: 'touch ok.txt' })).ok, true);
  assert.equal(requests.length, 0);

  const read = createToolRegistry({ level: 'read', workDir: dir, gate });
  const res = await read.dispatch('run_command', { command: 'touch no.txt' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Read only/);
});

test('Always allow for writes covers the rest of the run, sub-agents included', async () => {
  const dir = await sandboxDir();
  const { broker, requests } = answeringBroker('always');
  const runRules = createRunRules();
  const parent = createToolRegistry({ level: 'ask', workDir: dir, gate: { broker, runRules } });
  const child = createToolRegistry({ level: 'ask', workDir: dir, gate: { broker, runRules } });
  assert.equal((await parent.dispatch('write_file', { path: 'one.txt', content: '1' })).ok, true);
  assert.equal(runRules.allowWrites, true);
  assert.equal((await child.dispatch('edit_file', { path: 'one.txt', old: '1', new: '2' })).ok, true);
  assert.equal(requests.length, 1);
  assert.equal(await fs.readFile(path.join(dir, 'one.txt'), 'utf8'), '2');
});

test('a cancelled approval returns Run cancelled and runs nothing', async () => {
  const dir = await sandboxDir();
  const ac = new AbortController();
  const broker = createApprovalBroker({
    signal: ac.signal,
    emit: (type) => { if (type === 'approval-required') setImmediate(() => ac.abort()); }
  });
  const r = createToolRegistry({ level: 'ask', workDir: dir, gate: { broker } });
  const res = await r.dispatch('run_command', { command: 'touch never.txt' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Run cancelled.');
  assert.equal(await exists(path.join(dir, 'never.txt')), false);
});

test('the wait for a verdict goes through the pause the loop supplies', async () => {
  const dir = await sandboxDir();
  const { broker } = answeringBroker('allow');
  const r = createToolRegistry({ level: 'ask', workDir: dir, gate: { broker } });
  let paused = 0;
  const res = await r.dispatch('run_command', { command: 'touch p.txt' }, {
    pause: (p) => { paused += 1; return p; }
  });
  assert.equal(res.ok, true);
  assert.equal(paused, 1);
});

test('with no broker, Ask first refuses instead of running', async () => {
  const dir = await sandboxDir();
  const r = createToolRegistry({ level: 'ask', workDir: dir });
  const res = await r.dispatch('run_command', { command: 'touch x.txt' });
  assert.equal(res.ok, false);
  assert.match(res.error, /no way to ask/);
  assert.equal(await exists(path.join(dir, 'x.txt')), false);
});

test('the approval shows the real path, the sizes and the first lines', async () => {
  const dir = await sandboxDir();
  const { broker, requests } = answeringBroker('deny');
  const r = createToolRegistry({ level: 'ask', workDir: dir, gate: { broker } });

  await r.dispatch('write_file', { path: 'a.txt', content: 'replacement\n' });
  assert.ok(requests[0].detail.startsWith(`${path.join(dir, 'a.txt')}\n`), requests[0].detail);
  assert.match(requests[0].detail, /Overwrites the existing file \(24 bytes\) with 12 bytes\./);
  assert.match(requests[0].detail, /replacement/);
  assert.equal(requests[0].kind, 'write');
  assert.equal(requests[0].alwaysLabel, 'Allow for this run');

  const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  await r.dispatch('write_file', { path: 'fresh.txt', content: long });
  assert.match(requests[1].detail, /Creates a new file of \d+ bytes\./);
  assert.match(requests[1].detail, /line 20\n\.\.\. \(10 more lines\)/);
  assert.ok(!requests[1].detail.includes('line 21'));

  await r.dispatch('edit_file', { path: 'a.txt', old: 'world', new: 'there' });
  assert.equal(requests[2].title, 'Edit a file');
  assert.match(requests[2].detail, /a\.txt \(line 2\)\n\n- world\n\+ there$/);
});

test('a call that would fail anyway is refused before anyone is asked', async () => {
  const dir = await sandboxDir();
  const { broker, requests } = answeringBroker('allow');
  const r = createToolRegistry({ level: 'ask', workDir: dir, gate: { broker } });

  const miss = await r.dispatch('edit_file', { path: 'a.txt', old: 'absent text', new: 'x' });
  assert.match(miss.error, /matches 0 places/);
  const blocked = await r.dispatch('run_command', { command: 'rm -rf /' });
  assert.match(blocked.error, /blocked/i);
  assert.equal(requests.length, 0);
});

// Bypass

test('Bypass never asks and skips the blocklist', async () => {
  const dir = await sandboxDir();
  const { broker, requests } = answeringBroker('deny');
  const r = createToolRegistry({ level: 'bypass', workDir: dir, gate: { broker } });

  assert.equal((await r.dispatch('write_file', { path: 'b.txt', content: 'bypass' })).ok, true);
  // Harmless, but it matches the blocklist's power-off pattern.
  const echo = await r.dispatch('run_command', { command: 'echo shutdown' });
  assert.equal(echo.ok, true);
  assert.match(echo.result.stdout, /shutdown/);
  assert.equal(requests.length, 0);
});

test('the blocklist applies in Read only and Ask first', async () => {
  assert.equal(isSafeCommand('echo shutdown'), false);
  const read = await createToolRegistry({ level: 'read' }).dispatch('run_command', { command: 'echo shutdown' });
  assert.equal(read.ok, false);
  assert.match(read.error, /blocked/i);
  const { broker } = answeringBroker('allow');
  const ask = await createToolRegistry({ level: 'ask', gate: { broker } }).dispatch('run_command', { command: 'echo shutdown' });
  assert.match(ask.error, /blocked/i);
});

test('lowering the saved level applies to a run already going', async () => {
  const dir = await sandboxDir();
  let saved = 'bypass';
  const r = createToolRegistry({ level: 'bypass', workDir: dir, gate: { storedLevel: () => saved } });
  assert.equal((await r.dispatch('write_file', { path: 'one.txt', content: '1' })).ok, true);
  saved = 'read';
  const res = await r.dispatch('write_file', { path: 'two.txt', content: '2' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Read only/);
  saved = 'chat';
  assert.match((await r.dispatch('read_file', { path: 'one.txt' })).error, /Chat only/);
});

// edit_file

test('edit_file replaces exactly one match and refuses none or several, saying how many', async () => {
  const dir = await sandboxDir();
  await fs.writeFile(path.join(dir, 'e.txt'), 'alpha\nbeta\nalpha\n', 'utf8');
  const r = createToolRegistry({ level: 'bypass', workDir: dir });

  const two = await r.dispatch('edit_file', { path: 'e.txt', old: 'alpha', new: 'x' });
  assert.equal(two.ok, false);
  assert.match(two.error, /matches 2 places/);

  const none = await r.dispatch('edit_file', { path: 'e.txt', old: 'gamma', new: 'x' });
  assert.match(none.error, /matches 0 places/);

  const one = await r.dispatch('edit_file', { path: 'e.txt', old: 'beta', new: 'BETA' });
  assert.equal(one.ok, true);
  assert.equal(one.result.line, 2);
  assert.equal(await fs.readFile(path.join(dir, 'e.txt'), 'utf8'), 'alpha\nBETA\nalpha\n');

  assert.equal((await r.dispatch('edit_file', { path: 'e.txt', old: 'BETA\n', new: '' })).ok, true, '"" deletes');
  assert.equal(await fs.readFile(path.join(dir, 'e.txt'), 'utf8'), 'alpha\nalpha\n');
  assert.match((await r.dispatch('edit_file', { path: 'e.txt', old: 'x' })).error, /new is required/);
  assert.match((await r.dispatch('edit_file', { path: 'missing.txt', old: 'a', new: 'b' })).error, /No such file/);
});

test('overlapping matches count as ambiguous', async () => {
  const dir = await sandboxDir();
  await fs.writeFile(path.join(dir, 'o.txt'), 'aaa', 'utf8');
  const r = createToolRegistry({ level: 'bypass', workDir: dir });
  assert.match((await r.dispatch('edit_file', { path: 'o.txt', old: 'aa', new: 'b' })).error, /matches 2 places/);
});

// writes and their pre-write copies

test('write_file writes and reports what it replaced', async () => {
  const dir = await sandboxDir();
  const r = createToolRegistry({ level: 'bypass', fsRoot: dir });

  const created = await r.dispatch('write_file', { path: 'new.txt', content: 'fresh' });
  assert.equal(created.ok, true);
  assert.equal(created.result.replacedExisting, false);
  assert.equal(await fs.readFile(path.join(dir, 'new.txt'), 'utf8'), 'fresh');

  const replaced = await r.dispatch('write_file', { path: 'a.txt', content: 'overwritten' });
  assert.equal(replaced.result.replacedExisting, true);
  assert.ok(replaced.result.previousBytes > 0, 'should record the size it replaced');
});

test('every write keeps the old bytes in the run folder and records it', async () => {
  const dir = await sandboxDir();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-data-'));
  const runId = '11111111-2222-3333-4444-555555555555';
  const notes = [];
  const r = createToolRegistry({
    level: 'bypass', workDir: dir, dataDir, runId,
    audit: (kind, payload) => notes.push({ kind, ...payload })
  });
  const target = path.join(dir, 'a.txt');
  const before = runBackupDir(dataDir, runId);

  const first = await r.dispatch('write_file', { path: 'a.txt', content: 'v2' });
  assert.equal(first.ok, true);
  assert.equal(first.result.backup, path.join(before, backupName(target)));
  assert.equal(await fs.readFile(first.result.backup, 'utf8'), 'hello\nworld\nneedle here\n');

  const second = await r.dispatch('edit_file', { path: 'a.txt', old: 'v2', new: 'v3' });
  assert.equal(second.result.backup, `${path.join(before, backupName(target))}.2`);
  assert.equal(await fs.readFile(second.result.backup, 'utf8'), 'v2');

  const fresh = await r.dispatch('write_file', { path: 'brand-new.txt', content: 'x' });
  assert.equal(fresh.result.backup, undefined, 'a new file has nothing to keep');

  assert.deepEqual(notes.filter((n) => n.kind === 'backup').map((n) => n.path), [target, target]);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(first.result.backup)).mode & 0o777, 0o600);
  }
});

test('a write whose old bytes cannot be kept is refused', async () => {
  const dir = await sandboxDir();
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-data-'));
  // A data folder under a regular file: every mkdir fails with ENOTDIR.
  const notADir = path.join(base, 'not-a-directory');
  await fs.writeFile(notADir, 'x');
  const r = createToolRegistry({ level: 'bypass', workDir: dir, dataDir: path.join(notADir, 'nested'), runId: 'r1' });
  const res = await r.dispatch('write_file', { path: 'a.txt', content: 'lost?' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Could not keep a copy/);
  assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'hello\nworld\nneedle here\n');
});

test('backupName flattens an absolute path into one safe file name', () => {
  assert.equal(backupName('/Users/me/my project/a.txt'), 'Users_me_my_project_a.txt');
  assert.equal(backupName('C:\\Users\\me\\a.txt'), 'C_Users_me_a.txt');
  const long = backupName(`/${'deep/'.repeat(60)}file.txt`);
  assert.ok(long.length <= 151, `got ${long.length}`);
  assert.match(long, /^[0-9a-f]{10}_.*file\.txt$/);
});

test('pruneRunBackups removes only old run folders', async () => {
  const auditDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-prune-'));
  const oldRun = path.join(auditDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  const newRun = path.join(auditDir, 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee');
  const other = path.join(auditDir, 'keep-me');
  for (const d of [oldRun, newRun, other]) await fs.mkdir(path.join(d, 'before'), { recursive: true });
  const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await fs.utimes(oldRun, longAgo, longAgo);
  await fs.utimes(other, longAgo, longAgo);
  const { removed } = await pruneRunBackups(auditDir);
  assert.equal(removed, 1);
  assert.equal(await exists(oldRun), false);
  assert.equal(await exists(newRun), true);
  assert.equal(await exists(other), true, 'a folder that is not a run id is never touched');
});

// connector tools

function fakeConnectorTools(calls) {
  const make = (mcpTool, readOnly, permission) => ({
    kind: 'connector', description: `${mcpTool} tool (connector: Files)`, parameters: { path: 'string (required)' },
    readOnly, mutating: !readOnly, permission, connectorId: 'c1', connectorName: 'Files', mcpTool,
    execute: async (args) => { calls.push({ mcpTool, args }); return { text: `${mcpTool} done`, isError: false }; }
  });
  return {
    files__read: make('read', true, 'allow'),
    files__write: make('write', false, 'ask'),
    files__wipe: make('wipe', false, 'off')
  };
}

test('connector tools: Off is never offered; Read only offers only the read-only ones', async () => {
  const calls = [];
  const read = createToolRegistry({ level: 'read', extraTools: fakeConnectorTools(calls) });
  assert.ok(read.has('files__read'));
  assert.ok(!read.has('files__write'));
  assert.ok(!read.has('files__wipe'));
  assert.ok(!read.describeForPrompt().includes('files__write'));
  assert.equal((await read.dispatch('files__read', { path: 'x' })).ok, true);
  const denied = await read.dispatch('files__write', { path: 'x' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /Read only/);

  const bypass = createToolRegistry({ level: 'bypass', extraTools: fakeConnectorTools(calls) });
  assert.ok(!bypass.has('files__wipe'), 'Off holds even in Bypass');
  assert.equal((await bypass.dispatch('files__wipe', {})).ok, false);
  assert.equal((await bypass.dispatch('files__write', { path: 'x' })).ok, true, 'Bypass does not ask');
  assert.deepEqual(calls.map((c) => c.mcpTool), ['read', 'write']);
});

test('a connector tool called without its prefix resolves when the match is unique', async () => {
  const calls = [];
  const r = createToolRegistry({ level: 'read', extraTools: fakeConnectorTools(calls) });
  assert.equal((await r.dispatch('read', { path: 'x' })).ok, true);
  assert.deepEqual(calls.map((c) => c.mcpTool), ['read']);
  // A hidden tool stays hidden under its short name.
  const denied = await r.dispatch('wipe', {});
  assert.equal(denied.ok, false);
  assert.match(denied.error, /Unknown tool "wipe"/);
});

test('connector tools in Ask first: Allow runs, Ask asks, Always saves the permission', async () => {
  const calls = [];
  const persisted = [];
  const { broker, requests } = answeringBroker('always');
  const r = createToolRegistry({
    level: 'ask',
    extraTools: fakeConnectorTools(calls),
    gate: { broker, persistConnectorPermission: (key, permission, tool) => { persisted.push([key, permission, tool.connectorId, tool.mcpTool]); } }
  });
  assert.equal((await r.dispatch('files__read', { path: 'x' })).ok, true);
  assert.equal(requests.length, 0);

  const res = await r.dispatch('files__write', { path: 'x' });
  assert.equal(res.ok, true);
  assert.equal(requests[0].title, 'Use Files: write');
  assert.equal(requests[0].alwaysLabel, 'Always allow `write`');
  assert.deepEqual(persisted, [['files__write', 'allow', 'c1', 'write']]);

  await r.dispatch('files__write', { path: 'y' });
  assert.equal(requests.length, 1, 'the run-scoped grant covers the next call');
});

// run_command

test('run_command captures output, and a non-zero exit is data rather than a crash', async () => {
  const dir = await sandboxDir();
  const r = createToolRegistry({ level: 'bypass', fsRoot: dir, workDir: dir });

  const ok = await r.dispatch('run_command', { command: 'echo agent-works' });
  assert.equal(ok.ok, true);
  assert.match(ok.result.stdout, /agent-works/);
  assert.equal(ok.result.exitCode, 0);

  const bad = await r.dispatch('run_command', { command: 'exit 3' });
  assert.equal(bad.ok, true, 'the loop needs the failure as an observation');
  assert.equal(bad.result.failed, true);
  assert.equal(bad.result.exitCode, 3);
});

test('a failing command keeps stdout, where test runners print the failures', async () => {
  const dir = await sandboxDir();
  const r = createToolRegistry({ level: 'bypass', fsRoot: dir, workDir: dir });
  const res = await r.dispatch('run_command', { command: 'echo "test parse::bad_input ... FAILED"; exit 101' });
  assert.equal(res.result.exitCode, 101);
  assert.match(res.result.stdout, /bad_input \.\.\. FAILED/);
});

test('run_command starts in the project folder, else in home', async () => {
  const dir = await sandboxDir();
  const inProject = await createToolRegistry({ level: 'bypass', workDir: dir }).dispatch('run_command', { command: 'pwd' });
  assert.equal(inProject.result.stdout.trim(), await fs.realpath(dir));
  const inHome = await createToolRegistry({ level: 'bypass' }).dispatch('run_command', { command: 'pwd' });
  assert.equal(inHome.result.stdout.trim(), await fs.realpath(os.homedir()));
});

test('a missing working folder is named, not reported as a spawn error', async () => {
  const missing = path.join(os.tmpdir(), 'mirabilis-no-such-folder-xyz');
  const res = await createToolRegistry({ level: 'bypass' }).dispatch('run_command', { command: 'pwd', cwd: missing });
  assert.equal(res.ok, false);
  assert.equal(res.error, `Folder not found: ${missing}`);
});

test('a command that runs too long is stopped and says so', async () => {
  const r = createToolRegistry({ level: 'bypass', commandTimeoutMs: 300 });
  const started = Date.now();
  const res = await r.dispatch('run_command', { command: 'sleep 5' });
  assert.ok(Date.now() - started < 4_000, 'the timeout must not wait for the command');
  assert.equal(res.ok, true);
  assert.equal(res.result.exitCode, null);
  assert.match(res.result.note, /did not finish within/);
});

test('a runaway command\'s output is capped in memory', async () => {
  const r = createToolRegistry({ level: 'bypass' });
  const res = await r.dispatch('run_command', { command: 'yes 0123456789 | head -n 250000' });
  assert.equal(res.ok, true);
  assert.match(res.result.outputDropped, /characters of earlier output were not kept/);
  assert.ok(res.result.stdout.length <= 12_100);
});

test('commands run without the backend\'s own process settings', async () => {
  const saved = { PORT: process.env.PORT, NODE_ENV: process.env.NODE_ENV, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE };
  process.env.PORT = '4999';
  process.env.NODE_ENV = 'production';
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const r = createToolRegistry({ level: 'bypass' });
    const res = await r.dispatch('run_command', { command: 'echo "[$PORT][$NODE_ENV][$ELECTRON_RUN_AS_NODE]"; echo "$PATH"' });
    assert.match(res.result.stdout, /^\[\]\[\]\[\]$/m);
    assert.match(res.result.stdout, /\/usr\/sbin/, 'admin tools are on PATH');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('the blocklist is shared, so both callers enforce the same rules', () => {
  assert.equal(isSafeCommand('rm -rf /'), false);
  assert.equal(isSafeCommand('ls -la'), true);
  assert.equal(isSafeCommand('npm test'), true);
});

// the prompt

test('the prompt describes the offered tools, and says when a tool takes no arguments', () => {
  const r = createToolRegistry({
    level: 'read',
    extraTools: { mirabilis_status: { kind: 'read', description: 'Snapshot.', parameters: {}, execute: async () => ({}) } }
  });
  const text = r.describeForPrompt();
  assert.match(text, /read_file/);
  assert.match(text, /- mirabilis_status: Snapshot\.\n {6}\(no arguments\)/);
});

test('extra tools cannot replace a built-in', async () => {
  const dir = await sandboxDir();
  const r = createToolRegistry({
    workDir: dir,
    extraTools: { read_file: { kind: 'read', description: 'fake', parameters: {}, execute: async () => 'fake' } }
  });
  const res = await r.dispatch('read_file', { path: 'a.txt' });
  assert.match(res.result.text, /hello/);
});

// one file, one agent

test('one file, one agent', async () => {
  const dir = await sandboxDir();
  const runRules = createRunRules();
  const first = createToolRegistry({ level: 'bypass', workDir: dir, gate: { runRules } });
  const second = createToolRegistry({ level: 'bypass', workDir: dir, gate: { runRules } });
  const file = path.join(dir, 'x.txt');

  assert.equal((await first.dispatch('write_file', { path: 'x.txt', content: 'agent 0' }, { subAgent: 0 })).ok, true);
  const refused = await second.dispatch('write_file', { path: 'x.txt', content: 'agent 1' }, { subAgent: 1 });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Agent 1 is changing/);
  assert.equal(await fs.readFile(file, 'utf8'), 'agent 0', 'the second writer changed nothing');

  assert.equal((await first.dispatch('write_file', { path: 'x.txt', content: 'agent 0 again' }, { subAgent: 0 })).ok, true);
  assert.equal((await second.dispatch('write_file', { path: 'x.txt', content: 'the lead' })).ok, true, 'the lead is never blocked');
  runRules.writeClaims.clear();
  assert.equal((await second.dispatch('write_file', { path: 'x.txt', content: 'agent 1' }, { subAgent: 1 })).ok, true,
    'a new fan-out starts with no claims');
  assert.equal(await fs.readFile(file, 'utf8'), 'agent 1');
  await fs.rm(dir, { recursive: true, force: true });
});

test('one file, one agent, however the path is spelled', async () => {
  const dir = await sandboxDir();
  const runRules = createRunRules();
  // macOS and Windows disks ignore case, so the claim does too, on any host.
  const make = () => createToolRegistry({ level: 'bypass', workDir: dir, gate: { runRules }, platform: 'darwin' });
  const write = (file, subAgent) => make().dispatch('write_file', { path: file, content: `agent ${subAgent}` }, { subAgent });

  assert.equal((await write('Notes.md', 0)).ok, true);
  const otherCase = await write('notes.md', 1);
  assert.equal(otherCase.ok, false);
  assert.match(otherCase.error, /Agent 1 is changing/);

  // A symlinked folder is the folder it points to. 'junction' lets Windows make it unprivileged.
  await fs.mkdir(path.join(dir, 'real'));
  await fs.symlink(path.join(dir, 'real'), path.join(dir, 'link'), 'junction');
  assert.equal((await write('real/x.txt', 0)).ok, true);
  const viaLink = await write('link/x.txt', 1);
  assert.equal(viaLink.ok, false);
  assert.match(viaLink.error, /Agent 1 is changing/);
  assert.equal(await fs.readFile(path.join(dir, 'real', 'x.txt'), 'utf8'), 'agent 0');
  await fs.rm(dir, { recursive: true, force: true });
});

test('a write refused by a claim is never put to the user', async () => {
  const dir = await sandboxDir();
  const { broker, requests } = answeringBroker('allow');
  const runRules = createRunRules();
  const make = () => createToolRegistry({ level: 'ask', workDir: dir, gate: { broker, runRules } });

  assert.equal((await make().dispatch('write_file', { path: 'y.txt', content: '0' }, { subAgent: 0 })).ok, true);
  assert.equal(requests.length, 1);
  const refused = await make().dispatch('write_file', { path: 'y.txt', content: '1' }, { subAgent: 1 });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Agent 1 is changing/);
  assert.equal(requests.length, 1, 'the user is not asked about a write that cannot happen');
  await fs.rm(dir, { recursive: true, force: true });
});

test('a failed write leaves no claim', async () => {
  const dir = await sandboxDir();
  const runRules = createRunRules();
  const r = createToolRegistry({ level: 'bypass', workDir: dir, gate: { runRules } });

  const miss = await r.dispatch('edit_file', { path: 'a.txt', old: 'absent text', new: 'x' }, { subAgent: 0 });
  assert.equal(miss.ok, false);
  assert.match(miss.error, /matches 0 places/);
  const next = await r.dispatch('write_file', { path: 'a.txt', content: 'agent 1 wrote this' }, { subAgent: 1 });
  assert.equal(next.ok, true, next.error);
  assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'agent 1 wrote this');
  await fs.rm(dir, { recursive: true, force: true });
});
