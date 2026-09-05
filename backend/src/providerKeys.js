// @ts-check
// backend/src/providerKeys.js
// Provider API keys, held by the backend and never handed to the renderer.
//
// They used to live in browser local storage and travel on every request. That
// exposes them to any script that runs in the page: an XSS, a browser
// extension, a devtools paste. It also means the key sits in the browser
// profile directory in plain text, which is a file a great many things can read.
//
// Moving them here removes the whole renderer surface. The UI can SET a key and
// see a masked hint of it, and that is all: the value never travels back. The
// file is written 0600, the same discipline already used for the MCP token.
//
// Be honest about the limit. This is not protection against someone who is
// already running as you on this machine; on a single-user desktop, a process
// with your uid can read the OS keychain too. What it removes is the much wider
// set of things that can read a browser profile or run script in the page.

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
    // rename preserves the temp file's mode, but be explicit: this file must
    // never be group or world readable.
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
