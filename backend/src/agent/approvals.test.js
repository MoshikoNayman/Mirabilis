// The broker is the handoff between the loop (awaits) and the route or an abort
// (resolves). Verify every path a verdict can take.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApprovalBroker } from './approvals.js';

/** Collect emitted events for assertions. */
function recorder() {
  const events = [];
  return { emit: (type, payload) => events.push({ type, payload }), events };
}

test('a request emits approval-required and resolves to the route decision', async () => {
  const rec = recorder();
  const broker = createApprovalBroker({ emit: rec.emit });
  const pr = broker.request({ kind: 'command', title: 'Run a command', detail: 'npm install' });
  assert.ok(pr.approvalId, 'the promise carries its approval id');

  const required = rec.events.find((e) => e.type === 'approval-required');
  assert.equal(required.payload.approvalId, pr.approvalId);
  assert.equal(required.payload.title, 'Run a command');
  assert.equal(required.payload.detail, 'npm install');

  assert.equal(broker.resolve(pr.approvalId, 'allow'), 'ok');
  assert.equal(await pr, 'allow');
  const resolved = rec.events.find((e) => e.type === 'approval-resolved');
  assert.deepEqual(resolved.payload, { approvalId: pr.approvalId, decision: 'allow' });
});

test('always and deny are passed through, and a deny note is retrievable', async () => {
  const broker = createApprovalBroker({ emit: () => {} });
  const a = broker.request({ kind: 'command' });
  broker.resolve(a.approvalId, 'always');
  assert.equal(await a, 'always');

  const d = broker.request({ kind: 'write' });
  broker.resolve(d.approvalId, 'deny', 'do not touch config');
  assert.equal(await d, 'deny');
  assert.equal(broker.noteFor(d.approvalId), 'do not touch config');
});

test('resolve reports unknown and already-resolved', async () => {
  const broker = createApprovalBroker({ emit: () => {} });
  assert.equal(broker.resolve('nope', 'allow'), 'not-found');
  const pr = broker.request({ kind: 'command' });
  broker.resolve(pr.approvalId, 'allow');
  await pr;
  assert.equal(broker.resolve(pr.approvalId, 'deny'), 'already-resolved');
});

test('pending lists outstanding requests and clears as they resolve', async () => {
  const broker = createApprovalBroker({ emit: () => {} });
  const a = broker.request({ kind: 'command', title: 'A' });
  const b = broker.request({ kind: 'write', title: 'B' });
  assert.equal(broker.pending().length, 2);
  const row = broker.pending().find((r) => r.approvalId === a.approvalId);
  assert.equal(row.title, 'A');
  assert.ok(row.requestedAt);

  broker.resolve(a.approvalId, 'allow');
  await a;
  assert.equal(broker.pending().length, 1);
  broker.resolve(b.approvalId, 'deny');
  await b;
  assert.equal(broker.pending().length, 0);
});

test('cancelAll resolves every pending request to cancelled and returns the count', async () => {
  const rec = recorder();
  const broker = createApprovalBroker({ emit: rec.emit });
  const a = broker.request({ kind: 'command' });
  const b = broker.request({ kind: 'write' });
  assert.equal(broker.cancelAll('stop'), 2);
  assert.equal(await a, 'cancelled');
  assert.equal(await b, 'cancelled');
  assert.equal(broker.cancelAll('stop'), 0, 'nothing left to cancel');
});

test('an abort signal cancels all pending requests', async () => {
  const ac = new AbortController();
  const broker = createApprovalBroker({ emit: () => {}, signal: ac.signal });
  const a = broker.request({ kind: 'command' });
  ac.abort();
  assert.equal(await a, 'cancelled');
});

test('a request made after the signal aborted resolves cancelled at once', async () => {
  const ac = new AbortController();
  ac.abort();
  const broker = createApprovalBroker({ emit: () => {}, signal: ac.signal });
  const a = broker.request({ kind: 'command' });
  assert.equal(await a, 'cancelled');
  assert.equal(broker.pending().length, 0, 'it was never left pending');
});
