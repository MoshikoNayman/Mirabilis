// @ts-check
// Provider API keys, stored 0600 by the backend. The UI can set a key and see a masked hint, never the value.
// Keeps keys out of page script and the browser profile; it does not defend against code running as this user.

import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Show enough to recognise a key, never enough to use one. */
export function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

export function createProviderKeyStore(file) {
  /** @type {Record<string, string>} */
  let keys = {};
  let loaded = false;
  let lock = Promise.resolve();

  const withLock = (fn) => {
    const next = lock.then(fn, fn);
    lock = next.catch(() => {});
    return next;
  };

  async function persist() {
    const tmp = `${file}.tmp-${process.pid}`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify({ keys }), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
    // Must never be group or world readable; chmod explicitly rather than trust rename.
    await chmod(file, 0o600).catch(() => {});
  }

  return {
    file,

    async init() {
      if (loaded) return;
      loaded = true;
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        if (parsed && typeof parsed.keys === 'object') keys = parsed.keys;
      } catch { /* absent or unreadable: start empty */ }
    },

    /** The real key, for outbound calls only. Never leaves the backend. */
    get(provider) {
      return keys[String(provider || '')] || '';
    },

    /** What the UI is allowed to see. */
    listMasked() {
      return Object.entries(keys).map(([provider, key]) => ({
        provider,
        hasKey: Boolean(key),
        hint: maskKey(key)
      }));
    },

    async set(provider, key) {
      const p = String(provider || '').trim();
      const v = String(key || '').trim();
      if (!p) throw new Error('provider is required');
      if (!v) return this.remove(p);
      keys[p] = v;
      await withLock(persist);
      return { provider: p, hasKey: true, hint: maskKey(v) };
    },

    async remove(provider) {
      const p = String(provider || '').trim();
      delete keys[p];
      await withLock(persist);
      return { provider: p, hasKey: false, hint: '' };
    },

    async clear() {
      keys = {};
      await withLock(persist);
    },

    /** Test seam. */
    async _destroy() {
      keys = {}; loaded = false;
      await unlink(file).catch(() => {});
    }
  };
}
