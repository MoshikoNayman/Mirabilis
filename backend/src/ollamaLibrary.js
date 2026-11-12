// @ts-check
// The public Ollama library on ollama.com: search results, the tags of a model,
// and the per-runtime digests on a tag's own page. ollama.com has no API, so
// these parse its HTML; scripts/check-model-catalog.mjs runs them against the
// live site every week, so a markup change fails CI instead of the Models pane.

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readBodyCapped } from './ollamaRegistry.js';

export const LIBRARY_ORIGIN = 'https://ollama.com';
export const LIBRARY_CACHE_FILE = 'ollama-library-cache.json';

const TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const TTL_MS = 60 * 60 * 1000;
/** Older entries are no use even as a fallback. */
const MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounds the cache file to a few hundred kilobytes. */
const MAX_CACHE_ENTRIES = 80;
const WRITE_DELAY_MS = 1000;
/** After a failure, the same request answers from it for this long instead of waiting again. */
const RETRY_AFTER_MS = 30_000;
const MAX_QUERY_CHARS = 100;
const MAX_PAGE = 50;

/** Filters ollama.com's search takes, as `c=`. */
export const SEARCH_CAPABILITIES = ['tools', 'thinking', 'vision', 'embedding'];
/** Download size filters, as `s=`: up to N GB, or over 64. */
export const SEARCH_SIZES = ['8', '16', '32', '64', 'over64'];
export const SEARCH_ORDERS = ['popular', 'newest'];
const RESULT_CAPABILITIES = new Set(['tools', 'thinking', 'vision', 'embedding', 'audio']);

export const LIBRARY_ERRORS = {
  unreachable: 'Could not reach ollama.com. Check the connection.',
  unreadable: 'Could not read ollama.com. Update Mirabilis, then retry.',
  notFound: 'Not in the Ollama library. Check the name.'
};

export class LibraryError extends Error {
  /** @param {'unreachable'|'unreadable'|'not-found'} kind @param {string} message */
  constructor(kind, message) {
    super(message);
    this.name = 'LibraryError';
    this.kind = kind;
  }
}

const NAME_PART = '[a-z0-9][a-z0-9._-]{0,99}';
const LIBRARY_NAME_RE = new RegExp(`^${NAME_PART}(?:/${NAME_PART})?$`, 'i');
const TAG_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

/** "model" or "user/model", the names ollama.com serves pages for. */
export function isLibraryName(name) {
  const s = String(name ?? '');
  return s.length <= 160 && LIBRARY_NAME_RE.test(s) && !s.includes('..');
}

/** "library/qwen3" and "qwen3" are the same model; anything else invalid is ''. */
export function normalizeLibraryName(name) {
  const s = String(name ?? '').trim().replace(/^\/+/, '').replace(/^library\//i, '');
  return isLibraryName(s) ? s : '';
}

// ---------------------------------------------------------------------------
// Parsing

/** @type {Record<string, string>} */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  middot: '\u00b7', bull: '\u2022', hellip: '\u2026', ndash: '\u2013', mdash: '\u2014',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', copy: '\u00a9'
};

/** @param {string} s */
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? all;
  });
}

/** Visible text of an HTML fragment, whitespace collapsed. @param {string} html */
function textOf(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** @param {string} s */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** "/library/qwen3" -> "qwen3"; "/user/model" stays. '' for anything else. @param {string} href */
function nameFromHref(href) {
  return normalizeLibraryName(safeDecode(href));
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "November 8, 2026" -> "2026-11-08", or null. @param {string} text */
function isoDate(text) {
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(String(text || '').trim());
  if (!m) return null;
  const month = MONTHS.findIndex((name) => name.startsWith(m[1].toLowerCase()) && m[1].length >= 3);
  if (month < 0) return null;
  const date = new Date(Date.UTC(Number(m[3]), month, Number(m[2])));
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

const UNIT_BYTES = /** @type {Record<string, number>} */ ({ B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 });
const SIZE_RE = /^(\d+(?:\.\d+)?)\s*([KMGT]?B)(?:\s*-\s*(\d+(?:\.\d+)?)\s*([KMGT]?B))?$/;

/**
 * "18GB" or "304MB - 378MB" (the GGUF and MLX builds of one tag). Bytes are the
 * larger, the safer figure for "will it fit".
 * @param {string} text
 * @returns {{ size: string, sizeBytes: number } | null}
 */
export function parseSize(text) {
  const m = SIZE_RE.exec(String(text || '').trim());
  if (!m) return null;
  const [, a, ua, b, ub] = m;
  const bytes = Math.round(Number(a) * UNIT_BYTES[ua]);
  if (!b) return { size: `${a} ${ua}`, sizeBytes: bytes };
  const upper = Math.round(Number(b) * UNIT_BYTES[ub]);
  const size = ua === ub ? `${a}-${b} ${ua}` : `${a} ${ua}-${b} ${ub}`;
  return { size, sizeBytes: Math.max(bytes, upper) };
}

/** "256K" -> 262144 tokens, the way Ollama counts a context window. @param {string} text */
export function parseContext(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([KM]?)$/i.exec(String(text || '').trim());
  if (!m) return null;
  const scale = m[2].toUpperCase() === 'M' ? 1024 * 1024 : m[2].toUpperCase() === 'K' ? 1024 : 1;
  return Math.round(Number(m[1]) * scale);
}

const CARD_RE = /<li\b[^>]*>\s*<a\s+href="\/([^"?#]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/g;
// The site writes "<span  class=" with two spaces, so \s+.
const CHIP_RE = /<span\s+class="inline-flex items-center rounded-md\b([^"]*)"\s*>([\s\S]*?)<\/span>/g;
const SIZE_LABEL_RE = /^(?:\d+x)?\d+(?:\.\d+)?[kmbt]$|^e\d+(?:\.\d+)?b$/i;

/** @param {string} body */
function parseChips(body) {
  /** @type {string[]} */
  const capabilities = [];
  /** @type {string[]} */
  const sizes = [];
  let cloud = false;
  for (const chip of body.matchAll(CHIP_RE)) {
    const label = textOf(chip[2]).toLowerCase();
    if (!label || label.length > 16) continue;
    if (label === 'cloud') cloud = true;
    else if (RESULT_CAPABILITIES.has(label)) { if (!capabilities.includes(label)) capabilities.push(label); }
    else if (SIZE_LABEL_RE.test(label) || /ddf4ff/.test(chip[1])) { if (!sizes.includes(label)) sizes.push(label); }
  }
  return { capabilities, sizes, cloud };
}

/**
 * @typedef {{ name: string, description: string, capabilities: string[], sizes: string[],
 *   pulls: number|null, tags: number|null, updated: string|null }} LibraryModel
 */

/**
 * One page of https://ollama.com/search. Cloud-only models are left out: they
 * have a cloud chip and neither sizes nor tags to pull.
 * `recognized` is false when the page does not look like a search page at all.
 *
 * @param {string} html
 * @returns {{ results: LibraryModel[], hasMore: boolean, recognized: boolean }}
 */
export function parseSearchPage(html) {
  const src = String(html || '');
  /** @type {LibraryModel[]} */
  const results = [];
  const seen = new Set();
  let cards = 0;
  for (const m of src.matchAll(CARD_RE)) {
    const body = m[2];
    if (!/<h2\b/.test(body)) continue; // footer links and other lists, not model cards
    const name = nameFromHref(m[1]);
    if (!name) continue;
    cards += 1;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const { capabilities, sizes, cloud } = parseChips(body);
    const tagCount = />\s*(\d[\d,]*)\s+tags?\s*</i.exec(body);
    const tags = tagCount ? Number(tagCount[1].replace(/,/g, '')) : null;
    if (cloud && sizes.length === 0 && tags === null) continue;
    const pulls = /title="(\d[\d,]*)\s+downloads?"/i.exec(body);
    const updated = /title="Updated\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})"/.exec(body);
    const description = /<p\b[^>]*class="[^"]*line-clamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(body);
    results.push({
      name,
      description: description ? textOf(description[1]) : '',
      capabilities,
      sizes,
      pulls: pulls ? Number(pulls[1].replace(/,/g, '')) : null,
      tags,
      updated: updated ? isoDate(updated[1]) : null
    });
  }
  const hasMore = /data-has-more="true"/.test(src) || /hx-get="\/search\?[^"]*\bpage=\d+/.test(src);
  const recognized = cards > 0 || /data-result-count="\d+"/.test(src);
  return { results, hasMore, recognized };
}

/**
 * @typedef {{ name: string, family: string, tag: string, digest: string|null, size: string|null,
 *   sizeBytes: number|null, context: number|null, input: string[], mlx: boolean, latest: boolean,
 *   cloud: boolean }} TagRow
 */

const TAG_ROW_RE = /<a\s+href="\/([^"?#]+)"\s+class="md:hidden\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
const BADGE_RE = /<span\s+class="ml-2 inline-flex items-center rounded-full[^"]*"\s*>([\s\S]*?)<\/span>/g;
const BULLET_RE = /\s*\u2022\s*/;

/**
 * Every row of https://ollama.com/library/NAME/tags, cloud tags included and
 * marked, so update checks can see the digest of each tag.
 * @param {string} html
 * @returns {TagRow[]}
 */
export function parseTagsPage(html) {
  /** @type {TagRow[]} */
  const rows = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(TAG_ROW_RE)) {
    const href = safeDecode(m[1]);
    const colon = href.lastIndexOf(':');
    if (colon <= 0) continue;
    const family = nameFromHref(href.slice(0, colon));
    const tag = href.slice(colon + 1);
    if (!family || !TAG_RE.test(tag)) continue;
    const name = `${family}:${tag}`;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());

    const body = m[2];
    const badges = [...body.matchAll(BADGE_RE)].map((b) => textOf(b[1]).toLowerCase());
    const parts = textOf(body).split(BULLET_RE);
    const digest = (/<span\s+class="font-mono"\s*>\s*([0-9a-f]{12})\s*<\/span>/i.exec(body)
      || /\b([0-9a-f]{12})$/i.exec(parts[0] || ''))?.[1]?.toLowerCase() ?? null;
    /** @type {{ size: string, sizeBytes: number } | null} */
    let size = null;
    /** @type {number | null} */
    let context = null;
    /** @type {string[]} */
    let input = [];
    for (const part of parts.slice(1)) {
      if (!size) size = parseSize(part);
      const ctx = /^(\d+(?:\.\d+)?\s*[KM]?)\s+context window$/i.exec(part);
      if (context === null && ctx) context = parseContext(ctx[1]);
      const kinds = /^([A-Za-z]+(?:\s*,\s*[A-Za-z]+)*)\s+input\b/.exec(part);
      if (input.length === 0 && kinds) input = kinds[1].split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
    }
    const cloud = /(?:^|[-_])cloud$/i.test(tag) || (!size && parts.some((p) => /\busage\b/i.test(p)));
    rows.push({
      name,
      family,
      tag,
      digest,
      size: size?.size ?? null,
      sizeBytes: size?.sizeBytes ?? null,
      context,
      input,
      // MLX builds run on Apple silicon through Ollama's MLX engine. A gguf-* tag
      // is GGUF whatever its badge says.
      mlx: (badges.includes('mlx') || /mlx|nvfp4|mxfp8/i.test(tag)) && !/gguf/i.test(tag),
      latest: badges.includes('latest'),
      cloud
    });
  }
  return rows;
}

/**
 * @typedef {{ name: string, tag: string, digest: string|null, sizeBytes: number|null, size: string|null,
 *   context: number|null, input: string[], mlx: boolean, latest: boolean }} LibraryTag
 */

/**
 * Tags as the Models pane lists them: no cloud tags, and the literal "latest"
 * row folded into the tag it points to, which carries latest: true.
 * @param {TagRow[]} rows
 * @returns {LibraryTag[]}
 */
export function publicTags(rows) {
  const local = rows.filter((r) => !r.cloud);
  const latestRow = local.find((r) => r.tag.toLowerCase() === 'latest');
  const target = local.find((r) => r.latest && r.tag.toLowerCase() !== 'latest');
  const fold = !!latestRow && !!target && (!latestRow.digest || latestRow.digest === target.digest);
  return local
    .filter((r) => !(fold && r === latestRow))
    .map((r) => ({
      name: r.name,
      tag: r.tag,
      digest: r.digest,
      sizeBytes: r.sizeBytes,
      size: r.size,
      context: r.context,
      input: r.input,
      mlx: r.mlx,
      latest: r.latest || (r === latestRow && !target)
    }));
}

/**
 * The 12-hex manifest digests on a tag's own page (https://ollama.com/library/NAME:TAG),
 * one per runtime when the tag ships both an MLX and a llama.cpp build.
 * @param {string} html
 * @returns {string[]}
 */
export function parseTagPageDigests(html) {
  /** @type {string[]} */
  const out = [];
  for (const m of String(html || '').matchAll(/<p\b[^>]*>\s*([0-9a-f]{12})\s*(?:\u00b7|&middot;|&#183;|&#xb7;)/gi)) {
    const digest = m[1].toLowerCase();
    if (!out.includes(digest)) out.push(digest);
  }
  return out;
}

// ---------------------------------------------------------------------------
// URLs and fetching

/**
 * @typedef {{ q: string, capabilities: string[], size: string, order: string, page: number }} SearchQuery
 */

/**
 * Clamp a search to what ollama.com accepts; unknown filters are dropped.
 * @param {{ q?: any, capabilities?: any, size?: any, order?: any, page?: any }} [input]
 * @returns {SearchQuery}
 */
export function normalizeSearch(input = {}) {
  const list = Array.isArray(input.capabilities) ? input.capabilities : input.capabilities == null ? [] : [input.capabilities];
  const capabilities = SEARCH_CAPABILITIES.filter((c) => list.map((x) => String(x).toLowerCase()).includes(c));
  const size = SEARCH_SIZES.includes(String(input.size ?? '')) ? String(input.size) : '';
  const order = SEARCH_ORDERS.includes(String(input.order ?? '')) ? String(input.order) : 'popular';
  const page = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(input.page) || 1)));
  const q = typeof input.q === 'string' || typeof input.q === 'number' ? String(input.q) : '';
  return { q: q.trim().slice(0, MAX_QUERY_CHARS), capabilities, size, order, page };
}

/**
 * Always c=local: a cloud-only model has nothing to install. Popular is the
 * site's default order, and o=popular costs a redirect to the same page.
 * @param {SearchQuery} query
 */
export function searchUrl(query) {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  params.append('c', 'local');
  for (const c of query.capabilities) params.append('c', c);
  if (query.size) params.set('s', query.size);
  if (query.order !== 'popular') params.set('o', query.order);
  if (query.page > 1) params.set('page', String(query.page));
  return `${LIBRARY_ORIGIN}/search?${params}`;
}

/**
 * Headers for one search page. The site serves page 2 and later only to its own
 * infinite scroll (htmx); any other request is sent back to page 1.
 * @param {SearchQuery} query
 * @returns {Record<string, string>}
 */
export function searchHeaders(query) {
  return query.page > 1 ? { 'HX-Request': 'true' } : {};
}

/** @param {string} name a normalized library name */
function modelPath(name) {
  return name.includes('/') ? `/${name.split('/').map(encodeURIComponent).join('/')}` : `/library/${encodeURIComponent(name)}`;
}

/** @param {string} name */
export function tagsUrl(name) {
  return `${LIBRARY_ORIGIN}${modelPath(name)}/tags`;
}

/** @param {string} name @param {string} tag */
export function tagPageUrl(name, tag) {
  return `${LIBRARY_ORIGIN}${modelPath(name)}:${encodeURIComponent(tag)}`;
}

/**
 * GET one ollama.com page as text, bounded in time and size. Throws LibraryError,
 * or the Go Dark refusal untouched.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes?: number, headers?: Record<string, string> }} [opts]
 */
export async function fetchPage(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_PAGE_BYTES, headers = {} } = {}) {
  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'text/html', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.code === 'GO_DARK') throw err;
    throw new LibraryError('unreachable', LIBRARY_ERRORS.unreachable);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 404) throw new LibraryError('not-found', LIBRARY_ERRORS.notFound);
    throw new LibraryError('unreachable', LIBRARY_ERRORS.unreachable);
  }
  try {
    return (await readBodyCapped(res, maxBytes)).toString('utf8');
  } catch (err) {
    if (err?.code === 'TOO_LARGE') throw new LibraryError('unreadable', LIBRARY_ERRORS.unreadable);
    throw new LibraryError('unreachable', LIBRARY_ERRORS.unreachable);
  }
}

// ---------------------------------------------------------------------------
// The cached library

/**
 * ollama.com search and tags, cached on disk for an hour. When the site cannot be
 * reached or read, the last good copy is served marked stale. Under Go Dark
 * nothing is fetched and nothing is returned.
 *
 * @param {object} [opts]
 * @param {string} [opts.dataDir]  where the cache file lives; none keeps it in memory
 * @param {() => boolean} [opts.isGoDark]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now]
 * @param {number} [opts.ttlMs]
 */
export function createOllamaLibrary({ dataDir = '', isGoDark = () => false, fetchImpl, now = Date.now, ttlMs = TTL_MS } = {}) {
  const file = dataDir ? path.join(dataDir, LIBRARY_CACHE_FILE) : '';
  /** @type {Map<string, { at: number, value: any }>} */
  const entries = new Map();
  /** @type {Promise<void> | null} */
  let loaded = null;
  /** @type {Map<string, Promise<any>>} */
  const inFlight = new Map();
  /** @type {Map<string, { at: number, error: LibraryError }>} */
  const failures = new Map();
  /** @type {NodeJS.Timeout | null} */
  let writeTimer = null;
  let dirty = false;
  let writes = Promise.resolve();

  function load() {
    if (!loaded) {
      loaded = (async () => {
        if (!file) return;
        try {
          const parsed = JSON.parse(await readFile(file, 'utf8'));
          const stored = parsed?.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
          for (const [key, entry] of Object.entries(stored)) {
            if (!entry || typeof entry.at !== 'number' || now() - entry.at > MAX_STALE_MS) continue;
            entries.set(key, { at: entry.at, value: entry.value });
          }
        } catch {
          // Missing or unreadable: start empty, the next fetch rewrites it.
        }
      })();
    }
    return loaded;
  }

  /** Temp file then rename, so a crash mid-write keeps the previous copy. Never throws. */
  async function persist() {
    if (!file) return;
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }), { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, file);
    } catch {
      // A cache: losing a write costs one refetch.
      await unlink(tmp).catch(() => {});
    }
  }

  /**
   * Write now, then at most once per WRITE_DELAY_MS: a burst (typing in search)
   * costs two writes, and the first result is on disk at once.
   */
  function scheduleWrite() {
    if (!file) return;
    if (writeTimer) {
      dirty = true;
      return;
    }
    writes = writes.then(persist);
    writeTimer = setTimeout(function cooldown() {
      writeTimer = null;
      if (dirty) {
        dirty = false;
        scheduleWrite();
      }
    }, WRITE_DELAY_MS);
    writeTimer.unref?.();
  }

  /** Write any pending change now. */
  async function flush() {
    if (dirty) {
      dirty = false;
      writes = writes.then(persist);
    }
    await writes;
  }

  /** @param {string} key @param {any} value */
  function store(key, value) {
    entries.delete(key);
    entries.set(key, { at: now(), value });
    while (entries.size > MAX_CACHE_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    scheduleWrite();
  }

  /**
   * @template T
   * @param {string} key
   * @param {string} url
   * @param {(html: string) => T} parse  throws LibraryError('unreadable') on a page it does not recognize
   * @param {number} [timeoutMs]
   * @param {Record<string, string>} [headers]
   * @returns {Promise<{ goDark: true } | { goDark: false, value: T, stale: boolean }>}
   */
  async function cached(key, url, parse, timeoutMs, headers) {
    const dark = /** @type {{ goDark: true }} */ ({ goDark: true });
    /** @param {T} value @param {boolean} stale */
    const answer = (value, stale) => /** @type {{ goDark: false, value: T, stale: boolean }} */ ({ goDark: false, value, stale });
    if (isGoDark()) return dark;
    await load();
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttlMs) return answer(hit.value, false);
    const failed = failures.get(key);
    if (failed && now() - failed.at < RETRY_AFTER_MS) {
      if (hit) return answer(hit.value, true);
      throw failed.error;
    }
    const pending = inFlight.get(key);
    if (pending) return pending;
    const run = (async () => {
      try {
        const html = await fetchPage(url, { fetchImpl, timeoutMs, headers });
        const value = parse(html);
        failures.delete(key);
        store(key, value);
        return answer(value, false);
      } catch (err) {
        // Go Dark switched on mid-request.
        if (err?.code === 'GO_DARK') return dark;
        if (err instanceof LibraryError && err.kind === 'not-found') {
          if (hit) { entries.delete(key); scheduleWrite(); }
          throw err;
        }
        const error = err instanceof LibraryError ? err : new LibraryError('unreachable', LIBRARY_ERRORS.unreachable);
        if (failures.size > 200) failures.clear();
        failures.set(key, { at: now(), error });
        if (hit) return answer(hit.value, true);
        throw error;
      }
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, run);
    return run;
  }

  /** @param {string} name */
  function requireName(name) {
    const normalized = normalizeLibraryName(name);
    if (!normalized) throw new LibraryError('not-found', LIBRARY_ERRORS.notFound);
    return normalized;
  }

  /** @param {string} html */
  function parseRows(html) {
    const rows = parseTagsPage(html);
    // Every model page lists at least one tag; none means the markup moved.
    if (rows.length === 0) throw new LibraryError('unreadable', LIBRARY_ERRORS.unreadable);
    return rows;
  }

  /**
   * One page of search results.
   * @param {{ q?: any, capabilities?: any, size?: any, order?: any, page?: any }} [input]
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<{ page: number, hasMore: boolean, goDark: boolean, stale: boolean, results: LibraryModel[] }>}
   */
  async function search(input = {}, { timeoutMs } = {}) {
    const query = normalizeSearch(input);
    const url = searchUrl(query);
    const out = await cached(`search ${url}`, url, (html) => {
      const parsed = parseSearchPage(html);
      if (!parsed.recognized) throw new LibraryError('unreadable', LIBRARY_ERRORS.unreadable);
      return { results: parsed.results, hasMore: parsed.hasMore };
    }, timeoutMs, searchHeaders(query));
    if (out.goDark) return { page: query.page, hasMore: false, goDark: true, stale: false, results: [] };
    return { page: query.page, hasMore: out.value.hasMore, goDark: false, stale: out.stale, results: out.value.results };
  }

  /**
   * Every tag row of a model, cloud tags included, for update checks.
   * @param {string} name
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<{ goDark: true } | { goDark: false, stale: boolean, rows: TagRow[] }>}
   */
  async function tagRows(name, { timeoutMs } = {}) {
    const normalized = requireName(name);
    const out = await cached(`tags ${normalized.toLowerCase()}`, tagsUrl(normalized), parseRows, timeoutMs);
    if (out.goDark) return { goDark: true };
    return { goDark: false, stale: out.stale, rows: out.value };
  }

  /**
   * The installable tags of a model, as the API returns them.
   * @param {string} name
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<{ name: string, goDark: boolean, stale: boolean, tags: LibraryTag[] }>}
   */
  async function tags(name, { timeoutMs } = {}) {
    const normalized = requireName(name);
    const out = await tagRows(normalized, { timeoutMs });
    if (out.goDark) return { name: normalized, goDark: true, stale: false, tags: [] };
    return { name: normalized, goDark: false, stale: out.stale, tags: publicTags(out.rows) };
  }

  /**
   * The per-runtime digests on one tag's page.
   * @param {string} name
   * @param {string} tag
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<{ goDark: true } | { goDark: false, stale: boolean, digests: string[] }>}
   */
  async function tagDigests(name, tag, { timeoutMs } = {}) {
    const normalized = requireName(name);
    if (!TAG_RE.test(String(tag))) throw new LibraryError('not-found', LIBRARY_ERRORS.notFound);
    const key = `tag ${normalized.toLowerCase()}:${String(tag).toLowerCase()}`;
    const out = await cached(key, tagPageUrl(normalized, String(tag)), parseTagPageDigests, timeoutMs);
    if (out.goDark) return { goDark: true };
    return { goDark: false, stale: out.stale, digests: out.value };
  }

  return { search, tagRows, tags, tagDigests, flush };
}
