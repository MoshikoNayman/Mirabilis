import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { createToolRegistry } from './tools.js';
import { isSafeCommand, safeResolvePath } from './sandbox.js';

async function sandboxDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-agent-'));
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello\nworld\nneedle here\n', 'utf8');
  await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
  await fs.writeFile(path.join(dir, 'sub', 'b.js'), 'const x = 1; // needle\n', 'utf8');
  return dir;
}

// ── policy gate ─────────────────────────────────────────────────────────────

test('read-only is the default and withholds the mutating tools', async () => {
  const r = createToolRegistry();
  assert.equal(r.policy, 'read-only');
  assert.deepEqual(r.names().sort(), ['list_dir', 'read_file', 'search_files']);

  const res = await r.dispatch('write_file', { path: '/tmp/x', content: 'x' });
  assert.equal(res.ok, false);
  assert.match(res.error, /not permitted at the "read-only" policy/);
});

test('each policy tier grants exactly what it should', () => {
  assert.ok(!createToolRegistry({ policy: 'read-only' }).has('write_file'));
  assert.ok(createToolRegistry({ policy: 'write' }).has('write_file'));
  assert.ok(!createToolRegistry({ policy: 'write' }).has('run_command'), 'write must not imply exec');
  assert.ok(createToolRegistry({ policy: 'full' }).has('run_command'));
});

test('an unrecognised policy falls back to read-only rather than opening up', () => {
  const r = createToolRegistry({ policy: /** @type {any} */ ('superuser') });
  assert.equal(r.policy, 'read-only');
  assert.ok(!r.has('run_command'));
});

test('an unknown tool name is reported, not thrown', async () => {
  const res = await createToolRegistry().dispatch('rm_minus_rf', {});
  assert.equal(res.ok, false);
  assert.match(res.error, /Unknown tool/);
});

// ── the read tools ──────────────────────────────────────────────────────────

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

// ── the jail ────────────────────────────────────────────────────────────────

test('paths cannot escape the configured root', async () => {
  const dir = await sandboxDir();
  const r = createToolRegistry({ fsRoot: dir });
  for (const escape of ['../../../../etc/passwd', '/etc/passwd', 'sub/../../../..']) {
    const res = await r.dispatch('read_file', { path: escape });
    assert.equal(res.ok, false, `${escape} must be refused`);
    assert.match(res.error, /escapes the permitted filesystem root|not a file|ENOENT/);
  }
});

test('safeResolvePath rejects traversal and NUL bytes', () => {
  const root = '/tmp/mirabilis-jail-test';
  assert.throws(() => safeResolvePath('../escape', root), /escapes/);
  const ok = safeResolvePath('inside/file.txt', root);
  assert.ok(ok.startsWith(root));
  assert.ok(!safeResolvePath('a\0b', root).includes('\0'));
});

// ── mutation and execution ──────────────────────────────────────────────────

test('write_file writes and reports what it replaced', async () => {
  const dir = await sandboxDir();
  const r = createToolRegistry({ policy: 'write', fsRoot: dir });

  const created = await r.dispatch('write_file', { path: 'new.txt', content: 'fresh' });
  assert.equal(created.ok, true);
  assert.equal(created.result.replacedExisting, false);
  assert.equal(await fs.readFile(path.join(dir, 'new.txt'), 'utf8'), 'fresh');

  const replaced = await r.dispatch('write_file', { path: 'a.txt', content: 'overwritten' });
  assert.equal(replaced.result.replacedExisting, true);
  assert.ok(replaced.result.previousBytes > 0, 'should record the size it replaced');
});

test('run_command captures output, and a non-zero exit is data rather than a crash', async () => {
  const dir = await sandboxDir();
  const r = createToolRegistry({ policy: 'full', fsRoot: dir, workDir: dir });

  const ok = await r.dispatch('run_command', { command: 'echo agent-works' });
  assert.equal(ok.ok, true);
  assert.match(ok.result.text, /agent-works/);
  assert.equal(ok.result.exitCode, 0);

  const bad = await r.dispatch('run_command', { command: 'exit 3' });
  assert.equal(bad.ok, true, 'the loop needs the failure as an observation');
  assert.equal(bad.result.failed, true);
});

test('destructive commands are blocked even at the full policy', async () => {
  const r = createToolRegistry({ policy: 'full' });
  for (const cmd of ['rm -rf /', 'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/sda', 'shutdown -h now']) {
    const res = await r.dispatch('run_command', { command: cmd });
    assert.equal(res.ok, false, `${cmd} must be refused`);
    assert.match(res.error, /blocked/i);
  }
});

test('the blocklist is shared, so both callers enforce the same rules', () => {
  assert.equal(isSafeCommand('rm -rf /'), false);
  assert.equal(isSafeCommand('ls -la'), true);
  assert.equal(isSafeCommand('npm test'), true);
});

test('the prompt description lists only the granted tools', () => {
  const text = createToolRegistry({ policy: 'read-only' }).describeForPrompt();
  assert.match(text, /read_file/);
  assert.ok(!text.includes('run_command'), 'must not advertise a tool the run cannot use');
});
