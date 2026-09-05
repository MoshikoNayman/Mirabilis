// @ts-check
// backend/src/agent/runStore.js
// Durable record of agent runs across restarts.
//
// Runs used to live only in a Map, so a backend restart made a five-hour job
// vanish: no row, no status, nothing to tell the user their work had died. The
// browser tab would sit on a stalled panel forever.
//
// Be clear about what this does and does not do. It does NOT resume a run: the
// process that was talking to the model is gone and those in-flight calls cannot
// be recovered. What it does is make the loss VISIBLE and the work RECOVERABLE:
// a run interrupted by a restart is marked `interrupted` rather than silently
// forgotten, and its audit log still holds every step it completed.

import { readFile, writeFile, rename, mkdir, unlink, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Statuses that mean "this run was alive when the process stopped". */
const LIVE = new Set(['running', 'stopping']);

/** Keep the index bounded. */
const MAX_RECORDS = 200;

export function createRunStore(dir) {
  const file = join(dir, 'runs.json');
  /** @type {Map<string, any>} */
  let records = new Map();
  let loaded = false;
  /** Serialise writes so two finishing runs cannot clobber each other. */
  let lock = Promise.resolve();

  const withLock = (fn) => {
    const next = lock.then(fn, fn);
    lock = next.catch(() => {});
    return next;
  };

  async function persist() {
    const list = [...records.values()]
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, MAX_RECORDS);
    records = new Map(list.map((r) => [r.id, r]));
    // Same discipline as the other stores: temp file then rename, so a crash
    // mid-write leaves the previous index intact rather than a truncated one.
    const tmp = `${file}.tmp-${process.pid}`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify({ runs: list }), 'utf8');
    await copyFile(file, `${file}.bak`).catch(() => {});
    await rename(tmp, file);
  }

  return {
    file,

    /**
     * Load the index and reconcile it with reality.
     * Anything still marked live cannot be live: this process just started.
     */
    async init() {
      if (loaded) return { interrupted: 0 };
      loaded = true;
      /** @type {any} */
      let parsed = null;
      try {
        parsed = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        try { parsed = JSON.parse(await readFile(`${file}.bak`, 'utf8')); } catch { parsed = null; }
      }
      const list = Array.isArray(parsed?.runs) ? parsed.runs : [];
      let interrupted = 0;
      for (const r of list) {
        if (!r || !r.id) continue;
        if (LIVE.has(r.status)) {
          r.status = 'interrupted';
          r.stopReason = 'backend-restarted';
          interrupted += 1;
        }
        records.set(r.id, r);
      }
      if (interrupted > 0) await withLock(persist).catch(() => {});
      return { interrupted };
    },

    list() {
      return [...records.values()]
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    },

    get(id) {
      return records.get(id) || null;
    },

    /** Create or update a record. Persisted immediately: the point is durability. */
    async upsert(record) {
      if (!record?.id) return null;
      const merged = { ...(records.get(record.id) || {}), ...record };
      records.set(record.id, merged);
      await withLock(persist).catch(() => { /* never fail a run over bookkeeping */ });
      return merged;
    },

    async remove(id) {
      records.delete(id);
      await withLock(persist).catch(() => {});
    },

    /** Test seam. */
    async _reset() {
      records = new Map();
      loaded = false;
      await unlink(file).catch(() => {});
      await unlink(`${file}.bak`).catch(() => {});
    }
  };
}
