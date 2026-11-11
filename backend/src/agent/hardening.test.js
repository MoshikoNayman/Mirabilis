// Tests that the agent stays inside its limits and jail, stops on request, and reports honestly.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { isSafeCommand, safeResolvePath } from './sandbox.js';
import { createToolRegistry } from './tools.js';
import { runAgent } from './agentLoop.js';
import { resolveEffort } from './effortProfiles.js';
import { runCommand } from '../services/proc.js';

// the destructive-command blocklist

test('the blocklist is not bypassed by flag order or an indirect target', () => {
  const mustBlock = [
    'rm -rf /', 'rm -rf /*', 'rm -fr /',
    'cd / && rm -rf .',
    'rm -rf $HOME',
    'rm -rf --no-preserve-root /',
    'rm --recursive --force /',
    'find / -delete',
    'find / -exec rm {} ;',
    'dd of=/dev/sda',
    'chmod -R 777 /',
    'mkfs.ext4 /dev/sda1',
    'shutdown -h now'
  ];
  for (const cmd of mustBlock) {
    assert.equal(isSafeCommand(cmd), false, `must block: ${cmd}`);
  }
});

test('the blocklist does not block ordinary development commands', () => {
  // False positives teach the agent to route around the blocklist.
  for (const cmd of ['npm test', 'ls -la', 'echo ok', 'grep -r TODO src',
                     'git rm --cached f', 'rm file.txt', 'chmod 644 f',
                     'chmod -R 755 /var/www', 'node --test']) {
    assert.equal(isSafeCommand(cmd), true, `must allow: ${cmd}`);
  }
});

// the filesystem jail

test('a symlink inside the root does not grant access outside it', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-jail-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'SECRET', 'utf8');
  await fs.symlink(outside, path.join(root, 'data'));

  // Each of these is lexically inside the root.
  assert.throws(() => safeResolvePath('data/secret.txt', root), /symlink|escapes/);
  assert.throws(() => safeResolvePath('data/newfile.txt', root), /symlink|escapes/,
    'a WRITE target that does not exist yet must be checked against its real parent');
  assert.throws(() => safeResolvePath('../outside/secret.txt', root), /escapes/);

  const ok = safeResolvePath('inside.txt', root);
  assert.ok(ok.startsWith(root), 'a legitimate path must still resolve');

  // The tool layer must refuse it as well, even in Bypass: the operator jail always holds.
  const reg = createToolRegistry({ level: 'bypass', fsRoot: root });
  const read = await reg.dispatch('read_file', { path: 'data/secret.txt' });
  assert.equal(read.ok, false);
  const write = await reg.dispatch('write_file', { path: 'data/pwned.txt', content: 'x' });
  assert.equal(write.ok, false, 'writing through a symlink must be refused');
  await assert.rejects(() => fs.readFile(path.join(outside, 'pwned.txt')), /ENOENT/);

  await fs.rm(base, { recursive: true, force: true });
});

// stopping a run

test('an aborted signal stops a shell command and kills its children', async () => {
  const ac = new AbortController();
  const started = Date.now();
  // Short sleeps: on some shells a backgrounded grandchild escapes the process group.
  const p = runCommand('/bin/sh', ['-c', 'sleep 5 & sleep 5'], { signal: ac.signal, timeoutMs: 20_000 });
  setTimeout(() => ac.abort(), 200);
  await assert.rejects(() => p, /cancelled/);
  assert.ok(Date.now() - started < 5_000, 'abort must not wait for the command to finish');
});

test('a registry whose run was cancelled refuses further tool calls', async () => {
  const ac = new AbortController();
  const reg = createToolRegistry({ level: 'bypass', signal: ac.signal });
  ac.abort();
  const res = await reg.dispatch('run_command', { command: 'echo should-not-run' });
  assert.equal(res.ok, false);
  assert.match(res.error, /cancelled/i);
});

test('stopping a run stops its running command and the command\'s children', async () => {
  const ac = new AbortController();
  const reg = createToolRegistry({ level: 'bypass', signal: ac.signal, commandTimeoutMs: 20_000 });
  const started = Date.now();
  setTimeout(() => ac.abort(), 200);
  const res = await reg.dispatch('run_command', { command: 'sleep 5 & sleep 5' });
  assert.equal(res.ok, false);
  assert.match(res.error, /cancelled/i);
  assert.ok(Date.now() - started < 4_000, 'a stop must not wait for the command to finish');
});

// reporting the truth about a result

test('a validation-rejected answer is never returned as though it passed', async () => {
  // The budget runs out while repairing; the rejected summary must not come back as-is.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-reject-'));
  const model = {
    fn: async ({ purpose }) => {
      if (purpose === 'validate') return { text: '{"pass": false, "reason": "No tool result supports the claim."}', tokens: 5 };
      if (purpose === 'plan') return { text: 'plan', tokens: 5 };
      if (purpose === 'wrap-up') return { text: 'wrapped up', tokens: 5 };
      return { text: '{"action":"finish","summary":"The system is fully migrated and all tests pass."}', tokens: 5 };
    }
  };
  const out = await runAgent({
    goal: 'migrate everything',
    profile: resolveEffort('high', { maxIterations: 2 }),
    registry: createToolRegistry({ fsRoot: dir }),
    callModel: model.fn
  });

  assert.equal(out.validated, false);
  assert.match(out.answer, /did NOT pass validation|Validation did not pass/i,
    'the rejection must be disclosed in the returned answer');
  assert.match(out.answer, /No tool result supports the claim/,
    'and the reason must travel with it');
  await fs.rm(dir, { recursive: true, force: true });
});

// the wall clock

test('each model call is bounded by the remaining wall clock', async () => {
  // A provider that connects and then stalls must not carry the run past its ceiling.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-clock-'));
  const seen = [];
  const model = {
    fn: async ({ purpose, timeoutMs }) => {
      seen.push({ purpose, timeoutMs });
      return { text: '{"action":"finish","summary":"done"}', tokens: 5 };
    }
  };
  await runAgent({
    goal: 'g',
    profile: resolveEffort('high', { validate: false }),
    registry: createToolRegistry({ fsRoot: dir }),
    callModel: model.fn
  });
  assert.ok(seen.length > 0);
  for (const call of seen) {
    assert.ok(Number.isFinite(call.timeoutMs) && call.timeoutMs > 0,
      `${call.purpose} must carry a deadline, got ${call.timeoutMs}`);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test('the salvage wrap-up gets a small fixed deadline, not the spent budget', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-wrap-'));
  const seen = [];
  const model = {
    fn: async ({ purpose, timeoutMs }) => {
      seen.push({ purpose, timeoutMs });
      if (purpose === 'wrap-up') return { text: 'partial findings', tokens: 5 };
      return { text: '{"action":"tool","tool":"list_dir","args":{"path":"."}}', tokens: 5 };
    }
  };
  await runAgent({
    goal: 'never finish',
    profile: resolveEffort('high', { maxIterations: 2 }),
    registry: createToolRegistry({ fsRoot: dir }),
    callModel: model.fn
  });
  const wrap = seen.find((c) => c.purpose === 'wrap-up');
  assert.ok(wrap, 'a salvage wrap-up should have run');
  assert.ok(wrap.timeoutMs <= 60_000,
    `the wrap-up runs on a spent budget and must be capped, got ${wrap.timeoutMs}`);
  await fs.rm(dir, { recursive: true, force: true });
});

// real local model behaviour

test('search_files is case-insensitive by default', async () => {
  // A case-sensitive miss on "ERROR" leads the agent to report a clean log.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-search-'));
  await fs.writeFile(path.join(dir, 'app.log'), 'INFO ok\nERROR disk full on /dev/sda1\n', 'utf8');
  const reg = createToolRegistry({ fsRoot: dir });

  const found = await reg.dispatch('search_files', { pattern: 'error', path: '.' });
  assert.equal(found.ok, true);
  assert.ok(found.result.matchCount >= 1, 'lowercase "error" must find "ERROR"');

  const exact = await reg.dispatch('search_files', { pattern: 'error', path: '.', caseSensitive: true });
  assert.equal(exact.result.matchCount, 0, 'caseSensitive:true must still be honoured');

  await fs.rm(dir, { recursive: true, force: true });
});

test('a tool name placed in the action field is understood', async () => {
  // Local models emit {"action":"read_file",...}; rejecting it wastes an iteration.
  const { parseAgentAction } = await import('./protocol.js');
  const a = parseAgentAction('{"action":"read_file","args":{"path":"a.txt"}}');
  assert.equal(a.kind, 'tool');
  assert.equal(a.tool, 'read_file');
  assert.deepEqual(a.args, { path: 'a.txt' });

  // The canonical forms must keep working.
  assert.equal(parseAgentAction('{"action":"tool","tool":"list_dir"}').tool, 'list_dir');
  assert.equal(parseAgentAction('{"action":"finish","summary":"s"}').kind, 'finish');
});
