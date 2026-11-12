// @ts-check
// Whether each installed Ollama model is the build the library serves now, and
// whether Ollama itself has a newer release. Digests only: nothing is
// downloaded. Results live in model-updates.json in the data folder.

import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { headDigest as registryHeadDigest, isOllamaRegistryRef, normalizeDigest, parseModelRef, readBodyCapped } from './ollamaRegistry.js';

export const MODEL_UPDATES_FILE = 'model-updates.json';
const TTL_MS = 6 * 60 * 60 * 1000;
/** A check that failed on the network is retried sooner than a real answer. */
const TRANSIENT_TTL_MS = 15 * 60 * 1000;
const RELEASE_TTL_MS = 12 * 60 * 60 * 1000;
const RELEASE_RETRY_MS = 30 * 60 * 1000;
const CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 8000;
export const OLLAMA_RELEASE_URL = 'https://api.github.com/repos/ollama/ollama/releases/latest';
const MAX_RELEASE_BYTES = 1024 * 1024;

/** @typedef {'current'|'update'|'unknown'|'local'} UpdateStatus */
/** @typedef {{ status: UpdateStatus, reason?: string, transient?: boolean }} CheckResult */
/** @typedef {{ name: string, digest: string }} InstalledRef */
/** @typedef {{ name: string, digest: string, status: UpdateStatus, reason?: string, transient?: boolean, checkedAt: number }} CacheEntry */

/**
 * Run fn over items with at most `limit` in flight, results in input order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

/** "library/qwen3" -> "qwen3", the name ollama.com pages use. @param {{ repo: string }} ref */
function libraryName(ref) {
  return ref.repo.startsWith('library/') ? ref.repo.slice('library/'.length) : ref.repo;
}

/**
 * Compare one installed model with the library. Current when the registry serves
 * the same manifest, or when ollama.com lists the local digest for that tag: a tag
 * with both an MLX and a llama.cpp build answers the registry with one of them.
 *
 * @param {InstalledRef} model
 * @param {object} deps
 * @param {typeof registryHeadDigest} deps.headDigest
 * @param {Pick<ReturnType<typeof import('./ollamaLibrary.js').createOllamaLibrary>, 'tagRows'|'tagDigests'>} deps.library
 * @param {number} [deps.timeoutMs]
 * @returns {Promise<CheckResult>}
 */
export async function checkModel(model, { headDigest, library, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const ref = parseModelRef(model.name);
  if (!ref) return { status: 'unknown', reason: 'Not a valid model name' };
  if (!isOllamaRegistryRef(ref)) return { status: 'unknown', reason: 'Not from the Ollama library' };
  const digest = normalizeDigest(model.digest);
  if (!digest) return { status: 'unknown', reason: 'No local digest', transient: true };

  const remote = await headDigest(model.name, { timeoutMs });
  if (remote.status === 'missing') return { status: 'unknown', reason: 'No longer in the library' };
  if (remote.status !== 'found') return { status: 'unknown', reason: remote.reason || 'Registry unreachable', transient: true };
  if (remote.digest === digest) return { status: 'current' };

  const short = digest.slice(0, 12);
  const family = libraryName(ref);
  try {
    const listed = await library.tagRows(family, { timeoutMs });
    if (!listed.goDark && listed.rows.some((r) => r.tag.toLowerCase() === ref.tag && r.digest === short)) {
      return { status: 'current' };
    }
    const page = await library.tagDigests(family, ref.tag, { timeoutMs });
    if (!page.goDark && page.digests.includes(short)) return { status: 'current' };
  } catch {
    // ollama.com unreachable or the tag is gone from it: the registry's answer stands.
  }
  return { status: 'update' };
}

/**
 * Ollama's newest release number from GitHub, without the leading v.
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 */
export async function fetchLatestOllamaRelease({ fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const res = await fetchImpl(OLLAMA_RELEASE_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`GitHub answered ${res.status}`);
  }
  const body = JSON.parse((await readBodyCapped(res, MAX_RELEASE_BYTES)).toString('utf8'));
  const version = String(body?.tag_name || '').trim().replace(/^v/i, '');
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('The release has no version number.');
  return version;
}

/**
 * Numeric compare of "0.20.5" and "0.40.16"; a suffix such as -rc1 is ignored.
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a is older
 */
export function compareVersions(a, b) {
  const parts = (v) => String(v || '').trim().replace(/^v/i, '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * @typedef {{ install: 'homebrew'|'app'|'script'|'windows'|'unknown', updateCommand: string|null }} OllamaInstall
 */

/** @param {string} real @param {string} platform @returns {OllamaInstall} */
function classifyOllamaBinary(real, platform) {
  if (/[\\/]Cellar[\\/]ollama[\\/]/.test(real)) return { install: 'homebrew', updateCommand: 'brew upgrade ollama' };
  // The app updates itself, so there is no command to give.
  if (/[\\/]Ollama\.app[\\/]/.test(real)) return { install: 'app', updateCommand: null };
  if (platform === 'linux' && real.startsWith('/usr/local/')) {
    return { install: 'script', updateCommand: 'curl -fsSL https://ollama.com/install.sh | sh' };
  }
  return { install: 'unknown', updateCommand: null };
}

/**
 * How Ollama was installed here, read from the real path of the ollama binary,
 * and the command that updates it.
 * @param {{ platform?: string, env?: Record<string, string|undefined>, home?: string, realpathImpl?: (p: string) => Promise<string> }} [opts]
 * @returns {Promise<OllamaInstall>}
 */
export async function detectOllamaInstall({ platform = process.platform, env = process.env, home = os.homedir(), realpathImpl = realpath } = {}) {
  // The Windows installer keeps itself up to date.
  if (platform === 'win32') return { install: 'windows', updateCommand: null };
  const dirs = [...String(env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  if (platform === 'darwin') {
    dirs.push('/Applications/Ollama.app/Contents/Resources', path.join(home, 'Applications', 'Ollama.app', 'Contents', 'Resources'));
  }
  // Absolute entries only: a relative PATH entry would resolve against our own cwd.
  for (const dir of new Set(dirs.filter((d) => d && path.isAbsolute(d)))) {
    let real;
    try {
      real = await realpathImpl(path.join(dir, 'ollama'));
    } catch {
      continue;
    }
    return classifyOllamaBinary(real, platform);
  }
  return { install: 'unknown', updateCommand: null };
}

/**
 * Update checks with their cache, and the latest Ollama release.
 *
 * @param {object} deps
 * @param {Pick<ReturnType<typeof import('./ollamaLibrary.js').createOllamaLibrary>, 'tagRows'|'tagDigests'>} deps.library
 * @param {string} [deps.dataDir]  where model-updates.json lives; none keeps it in memory
 * @param {() => boolean} [deps.isGoDark]
 * @param {(name: string) => boolean} [deps.isLocal]  built on this machine (MCQ), never checked
 * @param {typeof registryHeadDigest} [deps.headDigest]
 * @param {typeof fetch} [deps.fetchImpl]  for the GitHub release lookup
 * @param {() => number} [deps.now]
 * @param {number} [deps.concurrency]
 * @param {number} [deps.timeoutMs]  per request
 */
export function createModelUpdates({
  library,
  dataDir = '',
  isGoDark = () => false,
  isLocal = () => false,
  headDigest = registryHeadDigest,
  fetchImpl,
  now = Date.now,
  concurrency = CONCURRENCY,
  timeoutMs = REQUEST_TIMEOUT_MS
}) {
  const file = dataDir ? path.join(dataDir, MODEL_UPDATES_FILE) : '';
  /** @type {{ models: Record<string, CacheEntry>, ollama: { latest: string|null, checkedAt: number, failedAt: number|null } }} */
  const state = { models: {}, ollama: { latest: null, checkedAt: 0, failedAt: null } };
  /** @type {Promise<void> | null} */
  let loaded = null;
  /** Checks run one after another, so a burst of requests costs one round of lookups. */
  let checks = Promise.resolve();
  /** @type {Promise<string|null> | null} */
  let releasing = null;
  let writes = Promise.resolve();

  const keyOf = (name) => String(name).trim().toLowerCase();

  function load() {
    if (!loaded) {
      loaded = (async () => {
        if (!file) return;
        try {
          const parsed = JSON.parse(await readFile(file, 'utf8'));
          for (const e of Object.values(parsed?.models || {})) {
            if (!e || typeof e.name !== 'string' || typeof e.checkedAt !== 'number' || !normalizeDigest(e.digest)) continue;
            if (!['current', 'update', 'unknown'].includes(e.status)) continue;
            state.models[keyOf(e.name)] = {
              name: e.name, digest: normalizeDigest(e.digest), status: e.status, checkedAt: e.checkedAt,
              ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
              ...(e.transient === true ? { transient: true } : {})
            };
          }
          const o = parsed?.ollama;
          if (o && typeof o === 'object') {
            state.ollama = {
              latest: typeof o.latest === 'string' ? o.latest : null,
              checkedAt: Number(o.checkedAt) || 0,
              failedAt: typeof o.failedAt === 'number' ? o.failedAt : null
            };
          }
        } catch {
          // Missing or unreadable: the next check rewrites it.
        }
      })();
    }
    return loaded;
  }

  /** Temp file then rename, mode 0600. A failed write costs one recheck. */
  function save() {
    if (!file) return Promise.resolve();
    const snapshot = JSON.stringify({ version: 1, models: state.models, ollama: state.ollama });
    writes = writes.then(async () => {
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      try {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 });
        await rename(tmp, file);
      } catch {
        await unlink(tmp).catch(() => {});
      }
    });
    return writes;
  }

  /** @param {CacheEntry | undefined} entry @param {InstalledRef} model @param {number} at */
  const fresh = (entry, model, at) => !!entry && entry.digest === normalizeDigest(model.digest)
    && at - entry.checkedAt < (entry.transient ? TRANSIENT_TTL_MS : TTL_MS);

  /**
   * What the API returns: one entry per installed model. With no installed list
   * (Ollama down), everything cached.
   * @param {InstalledRef[]} installed
   * @param {boolean} goDark
   */
  function view(installed, goDark) {
    /** @type {Record<string, { status: UpdateStatus, reason?: string }>} */
    const results = {};
    /** @type {number | null} */
    let oldest = null;
    /** @param {CacheEntry} e */
    const add = (e, name) => {
      results[name] = e.reason ? { status: e.status, reason: e.reason } : { status: e.status };
      oldest = oldest === null ? e.checkedAt : Math.min(oldest, e.checkedAt);
    };
    if (installed.length === 0) {
      for (const e of Object.values(state.models)) add(e, e.name);
    }
    for (const model of installed) {
      if (isLocal(model.name)) { results[model.name] = { status: 'local' }; continue; }
      const e = state.models[keyOf(model.name)];
      if (e && e.digest === normalizeDigest(model.digest)) add(e, model.name);
      else results[model.name] = { status: 'unknown', reason: 'Not checked yet' };
    }
    return { checkedAt: oldest === null ? null : new Date(oldest).toISOString(), goDark, results };
  }

  /** @param {InstalledRef[]} installed @param {boolean} refresh */
  async function run(installed, refresh) {
    const at = now();
    const due = installed.filter((m) => !isLocal(m.name) && (refresh || !fresh(state.models[keyOf(m.name)], m, at)));
    /** @param {InstalledRef} m @returns {Promise<CheckResult>} */
    const checkOne = (m) => checkModel(m, { headDigest, library, timeoutMs })
      .catch(() => ({ status: 'unknown', reason: 'Check failed', transient: true }));
    // One model first: with the registry unreachable, the rest would only wait out
    // their timeouts the same way, so they get its answer without a request.
    /** @type {CheckResult[]} */
    const results = [];
    if (due.length > 0) {
      const probe = await checkOne(due[0]);
      results.push(probe);
      const offline = probe.transient === true && probe.reason === 'Registry unreachable';
      results.push(...(offline ? due.slice(1).map(() => probe) : await mapLimit(due.slice(1), concurrency, checkOne)));
    }
    due.forEach((m, i) => {
      const r = results[i];
      state.models[keyOf(m.name)] = {
        name: m.name, digest: normalizeDigest(m.digest), status: r.status, checkedAt: at,
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.transient ? { transient: true } : {})
      };
    });
    // An entry for a model that is gone, or whose digest changed, is dropped.
    const keep = new Map(installed.map((m) => [keyOf(m.name), normalizeDigest(m.digest)]));
    let dropped = false;
    for (const [key, e] of Object.entries(state.models)) {
      if (keep.get(key) !== e.digest) { delete state.models[key]; dropped = true; }
    }
    if (due.length > 0 || dropped) await save();
  }

  /**
   * @param {{ models: InstalledRef[], refresh?: boolean }} input
   * @returns {Promise<{ checkedAt: string|null, goDark: boolean, results: Record<string, { status: UpdateStatus, reason?: string }>}>}
   */
  async function check({ models, refresh = false }) {
    await load();
    const installed = (Array.isArray(models) ? models : []).filter((m) => m && typeof m.name === 'string' && m.name.trim());
    // Go Dark never touches the network; Ollama down leaves nothing to compare.
    if (isGoDark() || installed.length === 0) return view(installed, isGoDark());
    const mine = checks.then(() => run(installed, refresh));
    checks = mine.catch(() => {});
    await mine;
    return view(installed, isGoDark());
  }

  /**
   * The newest Ollama release, cached for 12 hours. Under Go Dark, the cached
   * value or null, and no request.
   * @returns {Promise<string|null>}
   */
  async function latestOllama() {
    await load();
    const at = now();
    const o = state.ollama;
    if (isGoDark()) return o.latest;
    if (o.latest && at - o.checkedAt < RELEASE_TTL_MS) return o.latest;
    if (o.failedAt !== null && at - o.failedAt < RELEASE_RETRY_MS) return o.latest;
    if (!releasing) {
      releasing = fetchLatestOllamaRelease({ fetchImpl })
        .then((latest) => { state.ollama = { latest, checkedAt: now(), failedAt: null }; return latest; },
          () => { state.ollama = { ...state.ollama, failedAt: now() }; return state.ollama.latest; })
        .then(async (latest) => { await save(); return latest; })
        .finally(() => { releasing = null; });
    }
    return releasing;
  }

  /** Wait for pending writes (tests, shutdown). */
  const flush = () => writes;

  return { check, latestOllama, flush };
}
