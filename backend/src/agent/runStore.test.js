import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { createRunStore } from './runStore.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-runstore-'));

test('a run survives a restart instead of vanishing', async () => {
  const dir = await tmp();
  const a = createRunStore(dir);
  await a.init();
  await a.upsert({ id: 'r1', goal: 'long job', effort: 'session', status: 'completed', startedAt: '2026-01-01T00:00:00Z' });

  // A brand new store object stands in for a restarted process.
  const b = createRunStore(dir);
  await b.init();
  assert.equal(b.get('r1')?.goal, 'long job');
  await fs.rm(dir, { recursive: true, force: true });
});

test('a run that was live when the process died is marked interrupted, not left running', async () => {
  // This is the whole point. A stale "running" row means a panel that waits
  // forever for a run that no longer exists.
  const dir = await tmp();
  const a = createRunStore(dir);
  await a.init();
  await a.upsert({ id: 'r-live', goal: 'five hour job', status: 'running', startedAt: '2026-01-01T00:00:00Z' });
  await a.upsert({ id: 'r-stopping', goal: 'other', status: 'stopping', startedAt: '2026-01-01T00:00:00Z' });
  await a.upsert({ id: 'r-done', goal: 'finished', status: 'completed', startedAt: '2026-01-01T00:00:00Z' });

  const b = createRunStore(dir);
  const { interrupted } = await b.init();
  assert.equal(interrupted, 2, 'both live rows should be reconciled');
  assert.equal(b.get('r-live').status, 'interrupted');
  assert.equal(b.get('r-live').stopReason, 'backend-restarted');
  assert.equal(b.get('r-stopping').status, 'interrupted');
  assert.equal(b.get('r-done').status, 'completed', 'a finished run must not be touched');

  // And the reconciliation is itself durable.
  const c = createRunStore(dir);
  const again = await c.init();
  assert.equal(again.interrupted, 0, 'reconciling twice must not re-mark anything');
  assert.equal(c.get('r-live').status, 'interrupted');

  await fs.rm(dir, { recursive: true, force: true });
});

test('the run keeps a pointer to its audit log, so the work is still recoverable', async () => {
  const dir = await tmp();
  const s = createRunStore(dir);
  await s.init();
  await s.upsert({ id: 'r2', status: 'running', auditLog: '/data/agent-runs/r2.jsonl', startedAt: 'x' });

  const after = createRunStore(dir);
  await after.init();
  const rec = after.get('r2');
  assert.equal(rec.status, 'interrupted');
  assert.equal(rec.auditLog, '/data/agent-runs/r2.jsonl',
    'an interrupted run must still say where its record of work is');
  await fs.rm(dir, { recursive: true, force: true });
});

test('upsert merges rather than replacing', async () => {
  const dir = await tmp();
  const s = createRunStore(dir);
  await s.init();
  await s.upsert({ id: 'r3', goal: 'keep me', status: 'running', startedAt: 'x' });
  await s.upsert({ id: 'r3', status: 'completed', steps: 4 });
  const rec = s.get('r3');
  assert.equal(rec.goal, 'keep me', 'fields not in the update must survive');
  assert.equal(rec.status, 'completed');
  assert.equal(rec.steps, 4);
  await fs.rm(dir, { recursive: true, force: true });
});

test('concurrent finishes do not clobber each other', async () => {
  const dir = await tmp();
  const s = createRunStore(dir);
  await s.init();
  await Promise.all(Array.from({ length: 25 }, (_, i) =>
    s.upsert({ id: `c${i}`, goal: `g${i}`, status: 'completed', startedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z` })
  ));
  const after = createRunStore(dir);
  await after.init();
  assert.equal(after.list().length, 25, 'every concurrent write must be on disk');
  await fs.rm(dir, { recursive: true, force: true });
});

test('a corrupt index falls back to the backup rather than losing everything', async () => {
  const dir = await tmp();
  const s = createRunStore(dir);
  await s.init();
  await s.upsert({ id: 'good', goal: 'first', status: 'completed', startedAt: 'a' });
  await s.upsert({ id: 'good2', goal: 'second', status: 'completed', startedAt: 'b' });
  await fs.writeFile(path.join(dir, 'runs.json'), '{ truncated', 'utf8');

  const after = createRunStore(dir);
  await after.init();
  assert.ok(after.list().length >= 1, 'the backup should have carried something through');
  await fs.rm(dir, { recursive: true, force: true });
});

test('the index is bounded so it cannot grow without limit', async () => {
  const dir = await tmp();
  const s = createRunStore(dir);
  await s.init();
  for (let i = 0; i < 260; i += 1) {
    await s.upsert({ id: `x${i}`, status: 'completed', startedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z` });
  }
  assert.ok(s.list().length <= 200, `expected a bounded index, got ${s.list().length}`);
  await fs.rm(dir, { recursive: true, force: true });
});

test('an unwritable directory does not throw', async () => {
  const s = createRunStore('/proc/definitely-not-writable-here');
  await s.init();
  await s.upsert({ id: 'r', status: 'running', startedAt: 'x' });
  assert.equal(s.get('r').status, 'running', 'it still works in memory');
});
