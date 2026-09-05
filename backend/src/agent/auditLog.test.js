import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { createRunAuditor, readRunAudit, pruneRunAudits, redact } from './auditLog.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-audit-'));

test('a run records what it was permitted to do and everything it did', async () => {
  const dir = await tmp();
  const a = createRunAuditor({ dir, runId: 'run-1' });

  await a.start({
    goal: 'tidy the logs', effort: 'session', policy: 'full',
    provider: 'ollama', model: 'gemma3:12b', fsRoot: '/work',
    limits: { maxWallMs: 1000, maxIterations: 5, maxToolCalls: 20, maxSubAgents: 2 }
  });
  await a.tool({ iteration: 1, tool: 'run_command', args: { command: 'rm -rf ./build' }, mutating: true });
  await a.result({ iteration: 1, tool: 'run_command', ok: true, observation: 'removed' });
  await a.end({ stopReason: 'completed', steps: 1, validated: true, budget: { toolCalls: 1, elapsedMs: 42 }, answer: 'done' });

  const entries = await readRunAudit(dir, 'run-1');
  assert.deepEqual(entries.map((e) => e.kind), ['run-start', 'tool-call', 'tool-result', 'run-end']);

  const header = entries[0];
  assert.equal(header.policy, 'full', 'the permission granted must be on the record');
  assert.equal(header.fsRoot, '/work');
  assert.equal(header.model, 'gemma3:12b');

  // The single most important field: the command that actually ran.
  assert.match(entries[1].args, /rm -rf \.\/build/);
  assert.equal(entries[1].mutating, true);
  assert.equal(entries[3].stopReason, 'completed');
  for (const e of entries) assert.ok(e.at, 'every entry is timestamped');

  await fs.rm(dir, { recursive: true, force: true });
});

test('it is append-only, so a crash mid-run leaves the earlier lines readable', async () => {
  const dir = await tmp();
  const a = createRunAuditor({ dir, runId: 'run-2' });
  await a.start({ goal: 'g', effort: 'high', policy: 'read-only', limits: {} });
  await a.tool({ iteration: 1, tool: 'read_file', args: { path: 'a' } });
  // No end(): simulates the process dying mid-run.
  const entries = await readRunAudit(dir, 'run-2');
  assert.equal(entries.length, 2, 'what happened before the crash must survive');
  await fs.rm(dir, { recursive: true, force: true });
});

test('credentials are redacted before anything reaches disk', async () => {
  const dir = await tmp();
  const a = createRunAuditor({ dir, runId: 'run-3' });
  await a.tool({
    iteration: 1, tool: 'run_command',
    args: { command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnop1234" https://api.example.com' }
  });
  const raw = await fs.readFile(path.join(dir, 'run-3.jsonl'), 'utf8');
  assert.ok(!raw.includes('sk-abcdefghijklmnop1234'), 'an API key must never be written to the audit log');
  assert.match(raw, /redacted/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('redact catches the common credential shapes without eating ordinary text', () => {
  assert.match(redact('key is sk-abcdefghijklmnop1234'), /redacted/);
  assert.match(redact('ghp_abcdefghijklmnopqrst'), /redacted/);
  assert.match(redact('password: hunter2000'), /redacted/);
  assert.match(redact('API_KEY=abcdef123456'), /redacted/);
  // Should not mangle normal output.
  const plain = 'read 42 lines from app.log and found 2 errors';
  assert.equal(redact(plain), plain);
});

test('a long command is truncated but its beginning is preserved', async () => {
  const dir = await tmp();
  const a = createRunAuditor({ dir, runId: 'run-4' });
  await a.tool({ iteration: 1, tool: 'run_command', args: { command: 'echo ' + 'x'.repeat(50_000) } });
  const [entry] = await readRunAudit(dir, 'run-4');
  assert.ok(entry.args.length < 3_000, 'one huge command must not bloat the log');
  assert.match(entry.args, /^\{"command":"echo xxx/, 'the identifying start is kept');
  assert.match(entry.args, /truncated/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('auditing never throws, even when the directory cannot be written', async () => {
  // A read-only volume or a full disk must not be able to fail a run.
  const a = createRunAuditor({ dir: '/proc/definitely-not-writable-here', runId: 'run-5' });
  await a.start({ goal: 'g', effort: 'high', policy: 'read-only', limits: {} });
  await a.tool({ iteration: 1, tool: 'read_file', args: {} });
  await a.end({ stopReason: 'completed', steps: 1, validated: true, budget: {}, answer: 'x' });
  assert.equal(a.lineCount, 0, 'nothing was written, and nothing blew up');
});

test('pruning drops logs that are too old or too many', async () => {
  const dir = await tmp();
  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  for (const name of ['old-1', 'old-2']) {
    const f = path.join(dir, `${name}.jsonl`);
    await fs.writeFile(f, '{"kind":"run-start"}\n', 'utf8');
    await fs.utimes(f, new Date(old), new Date(old));
  }
  await fs.writeFile(path.join(dir, 'recent.jsonl'), '{"kind":"run-start"}\n', 'utf8');

  const { removed } = await pruneRunAudits(dir, { maxAgeDays: 30, maxFiles: 500 });
  assert.equal(removed, 2, 'both stale logs should go');
  const left = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  assert.deepEqual(left, ['recent.jsonl'], 'the recent one stays');

  await fs.rm(dir, { recursive: true, force: true });
});

test('pruning enforces a file-count ceiling, keeping the newest', async () => {
  const dir = await tmp();
  for (let i = 0; i < 6; i += 1) {
    const f = path.join(dir, `run-${i}.jsonl`);
    await fs.writeFile(f, '{}\n', 'utf8');
    const t = new Date(Date.now() - (6 - i) * 60_000);
    await fs.utimes(f, t, t);
  }
  const { removed } = await pruneRunAudits(dir, { maxAgeDays: 365, maxFiles: 3 });
  assert.equal(removed, 3);
  const left = (await fs.readdir(dir)).sort();
  assert.deepEqual(left, ['run-3.jsonl', 'run-4.jsonl', 'run-5.jsonl'], 'the three newest survive');
  await fs.rm(dir, { recursive: true, force: true });
});

test('pruning an absent directory is a no-op rather than an error', async () => {
  assert.deepEqual(await pruneRunAudits('/tmp/mirabilis-no-such-audit-dir-xyz'), { removed: 0 });
});
