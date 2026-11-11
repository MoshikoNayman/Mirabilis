// @ts-check
// Holds a run's pending approvals: the loop awaits a verdict, the route (or an
// abort) resolves it. One broker per run; its events drive the SSE stream.

import { randomUUID } from 'node:crypto';

/** @typedef {'allow'|'always'|'deny'|'cancelled'} Decision */

/**
 * @param {{ emit?: (type: string, payload: object) => void, signal?: AbortSignal }} [opts]
 */
export function createApprovalBroker({ emit = () => {}, signal } = {}) {
  /** @type {Map<string, {req: object, requestedAt: string, resolve: (d: Decision) => void}>} */
  const pending = new Map();
  /** @type {Map<string, string>} notes kept so the gate can quote a denial */
  const notes = new Map();
  /** @type {Set<string>} ids already settled, to tell resolve apart from not-found */
  const settledIds = new Set();
  let aborted = Boolean(signal?.aborted);

  const doEmit = (type, payload) => {
    try { emit(type, payload); } catch { /* a sink must never break the run */ }
  };

  function settle(id, decision, note) {
    const rec = pending.get(id);
    if (!rec) return false;
    pending.delete(id);
    settledIds.add(id);
    if (note != null && note !== '') notes.set(id, String(note));
    doEmit('approval-resolved', { approvalId: id, decision });
    rec.resolve(decision);
    return true;
  }

  /** Resolve every outstanding request to 'cancelled'. */
  function cancelAll(_reason) {
    let n = 0;
    for (const id of [...pending.keys()]) if (settle(id, 'cancelled')) n += 1;
    return n;
  }

  if (signal) {
    signal.addEventListener('abort', () => { aborted = true; cancelAll('aborted'); }, { once: true });
  }

  /**
   * Raise an approval and wait for a verdict. The returned promise also carries
   * `approvalId`, so the caller can read a denial note after awaiting.
   * @param {object} req
   * @returns {Promise<'allow'|'always'|'deny'|'cancelled'> & {approvalId: string}}
   */
  function request(req) {
    const approvalId = randomUUID();
    const requestedAt = new Date().toISOString();
    /** @type {(d: Decision) => void} */
    let resolveFn = () => {};
    const promise = /** @type {Promise<Decision> & {approvalId: string}} */ (
      new Promise((res) => { resolveFn = res; })
    );
    promise.approvalId = approvalId;

    if (aborted || signal?.aborted) {
      // Stopping already: do not leave a request hanging.
      settledIds.add(approvalId);
      doEmit('approval-resolved', { approvalId, decision: 'cancelled' });
      resolveFn('cancelled');
      return promise;
    }

    pending.set(approvalId, { req, requestedAt, resolve: resolveFn });
    doEmit('approval-required', { approvalId, ...req });
    return promise;
  }

  /**
   * @param {string} approvalId
   * @param {'allow'|'always'|'deny'} decision
   * @param {string} [note]
   * @returns {'ok'|'not-found'|'already-resolved'}
   */
  function resolve(approvalId, decision, note) {
    if (pending.has(approvalId)) { settle(approvalId, decision, note); return 'ok'; }
    return settledIds.has(approvalId) ? 'already-resolved' : 'not-found';
  }

  /** The note the user attached to a denial, or ''. */
  function noteFor(approvalId) {
    return notes.get(approvalId) || '';
  }

  /** Snapshot of outstanding requests, for a late-joining client. */
  function pendingList() {
    return [...pending.entries()].map(([approvalId, rec]) => ({
      approvalId, requestedAt: rec.requestedAt, ...rec.req
    }));
  }

  return { request, resolve, noteFor, pending: pendingList, cancelAll };
}
