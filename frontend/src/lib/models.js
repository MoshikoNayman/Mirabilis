// @ts-check
// Ollama model management for Settings > Models and the composer picker: the
// /api/models/* client plus the sizing, sorting and pick rules, kept here so
// they are testable. Picks follow the catalog order in backend/models.json.

import { apiFetch } from './api.js';

/** @typedef {'fits'|'tight'|'swap'} Fit */
/** @typedef {'current'|'update'|'unknown'|'local'} UpdateState */

/**
 * One item of GET /api/models?provider=ollama: a catalog row, or an installed
 * model the catalog does not list ("Installed locally").
 * @typedef {object} CatalogRow
 * @property {string} id
 * @property {string} [label]
 * @property {string} [group]
 * @property {string} [ollamaId]       pull name when it differs from id
 * @property {string} [size]           catalog download size, e.g. "6.6-7.6 GB"
 * @property {boolean} [available]     installed
 * @property {boolean} [uncensored]
 * @property {boolean} [local]         built on this machine (MCQ)
 * @property {number|null} [sizeBytes] installed size
 * @property {string[]} [capabilities]
 * @property {number|null} [contextWindow]
 */

/**
 * @typedef {object} OllamaRuntime
 * @property {boolean} reachable
 * @property {string|null} version
 * @property {string|null} latest
 * @property {boolean} updateAvailable
 * @property {'homebrew'|'app'|'script'|'windows'|'unknown'} install
 * @property {string|null} updateCommand  e.g. "brew upgrade ollama"; null means download
 * @property {string} downloadUrl
 */

/**
 * @typedef {object} InstalledModel
 * @property {string} name             e.g. "qwen3:8b"
 * @property {number|null} sizeBytes
 * @property {string} digest
 * @property {string} modifiedAt
 * @property {string} family
 * @property {string} paramSize        e.g. "8.2B"
 * @property {string} quant            e.g. "Q4_K_M"
 * @property {string} format
 * @property {string[]} capabilities
 * @property {number|null} contextWindow
 * @property {boolean} loaded
 * @property {{ id: string, label: string, group: string }|null} catalog
 * @property {boolean} uncensored
 * @property {boolean} local           built on this machine, e.g. MCQ
 */

/**
 * @typedef {object} InstalledPayload
 * @property {OllamaRuntime} runtime
 * @property {{ path: string, freeBytes: number|null, totalBytes: number|null }} disk
 * @property {InstalledModel[]} models
 */

/**
 * @typedef {object} UpdatesPayload
 * @property {string|null} checkedAt
 * @property {boolean} goDark
 * @property {Record<string, { status: UpdateState, reason: string }>} results
 */

/**
 * @typedef {object} LibraryModel
 * @property {string} name             e.g. "qwen3.5" or "user/model"
 * @property {string} description
 * @property {string[]} capabilities   subset of tools|thinking|vision|embedding|audio
 * @property {string[]} sizes          e.g. ["4b", "9b"]
 * @property {number|null} pulls
 * @property {number|null} tags
 * @property {string|null} updated
 */

/**
 * @typedef {object} LibraryPage
 * @property {number} page
 * @property {boolean} hasMore
 * @property {boolean} goDark
 * @property {boolean} stale
 * @property {LibraryModel[]} results
 */

/**
 * @typedef {object} LibraryTag
 * @property {string} name             e.g. "qwen3.5:9b"
 * @property {string} tag              e.g. "9b"
 * @property {number|null} sizeBytes
 * @property {string} size             e.g. "6.6 GB"
 * @property {number|null} context     tokens
 * @property {string[]} input          e.g. ["text", "image"]
 * @property {boolean} mlx             Apple silicon build
 * @property {boolean} latest          the tag "latest" points to
 */

/**
 * @typedef {object} InstallJob
 * @property {string} id
 * @property {string} modelId          lowercased pull name
 * @property {'queued'|'running'|'canceling'|'completed'|'failed'|'canceled'} status
 * @property {number|null} pct         overall, never goes backwards
 * @property {string} message
 * @property {string} error            short plain sentence when failed
 * @property {boolean} done
 * @property {number|null} completedBytes
 * @property {number|null} totalBytes
 * @property {number|null} bytesPerSec
 * @property {number|null} etaSec
 */

/** @param {unknown} v @returns {string} */
const str = (v) => (typeof v === 'string' ? v : '');
/** @param {unknown} v @returns {string|null} */
const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v : null);
/** @param {unknown} v @returns {number|null} */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** @param {unknown} v @returns {string[]} */
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s !== '') : []);

/* Sizes */

/** @type {Record<string, number>} */
const UNIT_BYTES = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/**
 * Bytes from a byte count or a size text. A range such as "6.6-7.6 GB" gives its
 * larger end; a number without a unit takes the unit that follows it.
 * @param {unknown} size
 * @returns {number|null}
 */
export function parseSizeBytes(size) {
  if (typeof size === 'number') return Number.isFinite(size) && size > 0 ? size : null;
  if (typeof size !== 'string') return null;
  const parts = [...size.matchAll(/(\d+(?:\.\d+)?)\s*([KMGT]?B)?/gi)];
  let unit = '';
  let best = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i][2]) unit = parts[i][2].toUpperCase();
    if (!unit) continue;
    best = Math.max(best, parseFloat(parts[i][1]) * UNIT_BYTES[unit]);
  }
  return best > 0 ? best : null;
}

/** @param {number} v */
const oneDecimal = (v) => (v < 9.95 ? v.toFixed(1) : String(Math.round(v)));

/**
 * Decimal units, as Ollama shows them: "5.2 GB", "18 GB", "815 MB".
 * @param {unknown} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (bytes == null || !Number.isFinite(n) || n < 0) return '';
  if (n >= 1e12) return `${oneDecimal(n / 1e12)} TB`;
  if (n >= 1e9) return `${oneDecimal(n / 1e9)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${Math.round(n)} B`;
}

/**
 * The size a fit is judged on: installed bytes, else the catalog size text.
 * @param {{ sizeBytes?: unknown, size?: unknown }|null|undefined} item
 * @returns {number|string|null}
 */
export function itemSize(item) {
  const bytes = Number(item?.sizeBytes);
  if (item?.sizeBytes != null && Number.isFinite(bytes) && bytes > 0) return bytes;
  return typeof item?.size === 'string' ? item.size : null;
}

/* Fit */

export const FIT_LABELS = Object.freeze({ fits: 'Fits', tight: 'Tight', swap: 'Will swap' });

/**
 * Whether a model runs in this machine's memory. The runtime takes about 1.2x
 * the weights (KV cache, activations); Fits leaves 40% for the OS and apps.
 * @param {unknown} size  bytes, or a catalog size text such as "6.6-7.6 GB"
 * @param {unknown} ramGb total memory in GB
 * @returns {Fit|null} null without both numbers
 */
export function modelFit(size, ramGb) {
  const ram = Number(ramGb);
  const bytes = parseSizeBytes(size);
  if (!bytes || ramGb == null || !Number.isFinite(ram) || ram <= 0) return null;
  const required = (bytes / 1e9) * 1.2;
  if (required <= ram * 0.6) return 'fits';
  if (required <= ram * 0.82) return 'tight';
  return 'swap';
}

/**
 * The numbers behind a fit chip, e.g. "7.6 GB weights, 16 GB memory".
 * @param {unknown} size
 * @param {unknown} ramGb
 */
export function fitDetail(size, ramGb) {
  const bytes = parseSizeBytes(size);
  const ram = Number(ramGb);
  if (!bytes || !Number.isFinite(ram) || ram <= 0) return '';
  return `${(bytes / 1e9).toFixed(1)} GB weights, ${ram} GB memory`;
}

/**
 * Download-size filter ("s") for the library search on this machine: 16 GB of
 * memory searches downloads up to 8 GB. Null above 128 GB, where nothing is cut.
 * @param {unknown} ramGb
 * @returns {'8'|'16'|'32'|'64'|null}
 */
export function fitBucket(ramGb) {
  const ram = Number(ramGb);
  if (ramGb == null || !Number.isFinite(ram) || ram <= 0) return null;
  if (ram <= 16) return '8';
  if (ram <= 32) return '16';
  if (ram <= 64) return '32';
  if (ram <= 128) return '64';
  return null;
}

/* Other formatting */

/**
 * Context window in tokens as the library writes it: 262144 and 256000 are
 * both "256K", since the page's "256K" may have been read either way.
 * @param {unknown} tokens
 */
export function formatContext(tokens) {
  const n = Number(tokens);
  if (tokens == null || !Number.isFinite(n) || n <= 0) return '';
  if (n >= 1e6) {
    const m = n % 1e6 === 0 ? n / 1e6 : n / 1048576;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  const k = n % 1000 === 0 ? n / 1000 : n % 1024 === 0 ? n / 1024 : Math.round(n / 1024);
  return `${k}K`;
}

/**
 * Pull count as ollama.com writes it: 25190641 -> "25M".
 * @param {unknown} count
 */
export function formatCount(count) {
  const n = Number(count);
  if (count == null || !Number.isFinite(n) || n < 0) return '';
  /** @param {number} v @param {string} suffix */
  const short = (v, suffix) => `${v < 9.95 ? Number(v.toFixed(1)) : Math.round(v)}${suffix}`;
  if (n >= 1e9) return short(n / 1e9, 'B');
  if (n >= 1e6) return short(n / 1e6, 'M');
  if (n >= 1e3) return short(n / 1e3, 'K');
  return String(Math.round(n));
}

/** @param {unknown} bytesPerSec */
export function formatRate(bytesPerSec) {
  const n = Number(bytesPerSec);
  if (bytesPerSec == null || !Number.isFinite(n) || n <= 0) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB/s`;
  if (n >= 1e6) return `${n >= 1e7 ? Math.round(n / 1e6) : (n / 1e6).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(n / 1e3))} KB/s`;
}

/** @param {unknown} sec */
export function formatEta(sec) {
  const n = Number(sec);
  if (sec == null || !Number.isFinite(n) || n <= 0) return '';
  if (n < 60) return `${Math.ceil(n)} s left`;
  if (n < 3600) return `${Math.ceil(n / 60)} min left`;
  const h = Math.floor(n / 3600);
  const m = Math.round((n % 3600) / 60);
  return m ? `${h} h ${m} min left` : `${h} h left`;
}

/**
 * Progress line for an install job: "2.1 of 6.6 GB, 12 MB/s, 3 min left".
 * @param {Partial<InstallJob>|null|undefined} job
 */
export function jobProgressText(job) {
  if (!job) return '';
  if (job.status === 'queued') return 'Queued';
  if (job.status === 'canceling') return 'Canceling';
  /** @type {string[]} */
  const parts = [];
  const total = Number(job.totalBytes);
  const done = Number(job.completedBytes);
  if (job.totalBytes != null && total > 0 && job.completedBytes != null && Number.isFinite(done) && done >= 0) {
    const giga = total >= 1e9;
    const part = giga ? (Math.min(done, total) / 1e9).toFixed(1) : String(Math.round(Math.min(done, total) / 1e6));
    parts.push(`${part} of ${giga ? `${oneDecimal(total / 1e9)} GB` : `${Math.round(total / 1e6)} MB`}`);
  } else if (typeof job.pct === 'number' && Number.isFinite(job.pct)) {
    parts.push(`${Math.round(job.pct)}%`);
  }
  // After the last byte Ollama verifies and writes; a speed would only decay.
  if (job.message === 'Verifying' || job.message === 'Writing') return [...parts, job.message].join(', ');
  const rate = formatRate(job.bytesPerSec);
  if (rate) parts.push(rate);
  const eta = formatEta(job.etaSec);
  if (eta) parts.push(eta);
  return parts.join(', ') || 'Starting';
}

/** @param {unknown} iso @returns {number|null} */
function timeOf(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * "just now", "5 min ago", "3 h ago", "2 d ago".
 * @param {unknown} iso
 * @param {number} [now]
 */
export function formatAgo(iso, now = Date.now()) {
  const t = timeOf(iso);
  if (t == null) return '';
  const sec = Math.max(0, (now - t) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  return `${Math.floor(sec / 86400)} d ago`;
}

/* Names */

/**
 * Lowercase, with ":latest" when no tag is given, so "Dolphin3" and
 * "dolphin3:latest" compare equal.
 * @param {unknown} name
 */
export function normalizeModelName(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return '';
  return n.indexOf(':', n.lastIndexOf('/') + 1) === -1 ? `${n}:latest` : n;
}

/** The name before the tag: "qwen3:8b" -> "qwen3". @param {unknown} name */
export function baseModelName(name) {
  const n = String(name ?? '').trim().toLowerCase();
  const colon = n.indexOf(':', n.lastIndexOf('/') + 1);
  return colon === -1 ? n : n.slice(0, colon);
}

/**
 * What Ollama pulls for a catalog row.
 * @param {{ id?: string, ollamaId?: string }|null|undefined} row
 */
export function pullName(row) {
  return String(row?.ollamaId || row?.id || '').trim();
}

/**
 * The key a pull is tracked under: the catalog row that pulls this name, so the
 * picker and the pane share progress, or the lowercased name itself. A job's
 * modelId ("dolphin-mixtral:8x7b") maps back to its row ("dolphin-mixtral").
 * @param {unknown} name
 * @param {CatalogRow[]} [rows]
 */
export function rowIdForName(name, rows = []) {
  const want = normalizeModelName(name);
  if (!want) return '';
  const list = Array.isArray(rows) ? rows : [];
  const hit = list.find((r) => r && r.ollamaId && normalizeModelName(r.ollamaId) === want)
    || list.find((r) => r && normalizeModelName(r.id) === want);
  return hit ? hit.id : String(name).trim().toLowerCase();
}

/**
 * Whether the picker list shows this name installed, so a pull of it is an update.
 * @param {unknown} name
 * @param {CatalogRow[]} [rows]
 */
export function isInstalledName(name, rows = []) {
  const want = normalizeModelName(name);
  if (!want) return false;
  return (Array.isArray(rows) ? rows : []).some((r) => r && r.available === true && normalizeModelName(pullName(r)) === want);
}

const EXACT_NAME_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*(?::[a-z0-9][a-z0-9._-]*)?$/i;

/**
 * A search that names one model exactly ("name:tag" or "user/name"), or ''.
 * @param {unknown} query
 */
export function exactModelName(query) {
  const q = String(query ?? '').trim();
  if (!q || q.length > 100 || !EXACT_NAME_RE.test(q)) return '';
  return q.includes(':') || q.includes('/') ? q : '';
}

/* Lists */

const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Loaded models first, then by name.
 * @template {{ name: string, loaded?: boolean }} T
 * @param {T[]} models
 * @returns {T[]}
 */
export function sortInstalled(models) {
  return [...(Array.isArray(models) ? models : [])].sort((a, b) =>
    Number(Boolean(b.loaded)) - Number(Boolean(a.loaded)) || byName.compare(a.name, b.name));
}

const PLAIN_TAG_RE = /^e?\d+(?:\.\d+)?[bkm]$/i;

/**
 * Tags in the order to offer them: the default build, plain sizes, MLX builds
 * (first on Apple silicon, last elsewhere), quantizations; then smallest first.
 * The "latest" alias goes last when another tag carries the latest mark.
 * @param {LibraryTag[]} tags
 * @param {{ appleSilicon?: boolean }} [opts]
 * @returns {LibraryTag[]}
 */
export function sortTags(tags, { appleSilicon = false } = {}) {
  const list = Array.isArray(tags) ? tags : [];
  const marked = list.some((t) => t.latest && t.tag !== 'latest');
  /** @param {LibraryTag} t */
  const rank = (t) => {
    if (t.tag === 'latest') return marked ? 6 : 0;
    if (t.latest) return 0;
    if (PLAIN_TAG_RE.test(t.tag)) return 1;
    if (t.mlx) return appleSilicon ? 2 : 5;
    return 3;
  };
  /** @param {LibraryTag} t */
  const size = (t) => t.sizeBytes ?? parseSizeBytes(t.size) ?? Number.MAX_SAFE_INTEGER;
  return [...list].sort((a, b) => rank(a) - rank(b) || size(a) - size(b) || byName.compare(a.tag, b.tag));
}

/**
 * How many sorted tags to show before "All N tags": the default, plain sizes
 * and (on Apple silicon) MLX builds, at least 4 and at most 8.
 * @param {LibraryTag[]} sorted from sortTags
 * @param {{ appleSilicon?: boolean }} [opts]
 */
export function primaryTagCount(sorted, { appleSilicon = false } = {}) {
  const list = Array.isArray(sorted) ? sorted : [];
  const primary = list.filter((t) => (t.latest && t.tag !== 'latest') || PLAIN_TAG_RE.test(t.tag) || (appleSilicon && t.mlx)).length;
  return Math.min(list.length, Math.max(4, Math.min(8, primary || 4)));
}

/**
 * Rows grouped by catalog group, groups and rows in catalog order.
 * @template {{ group?: string }} T
 * @param {T[]} rows
 * @returns {{ group: string, rows: T[] }[]}
 */
export function groupByCatalog(rows) {
  /** @type {Map<string, T[]>} */
  const groups = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const g = r.group || 'Models';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)?.push(r);
  }
  return [...groups.entries()].map(([group, list]) => ({ group, rows: list }));
}

/**
 * Catalog picks to suggest: not installed and not going to swap on this machine.
 * Without a memory figure every pick qualifies.
 * @param {CatalogRow[]} rows
 * @param {unknown} ramGb
 */
export function recommendedGroups(rows, ramGb) {
  const picks = (Array.isArray(rows) ? rows : []).filter((r) =>
    r && r.available === false && r.group !== 'Installed locally' && modelFit(itemSize(r), ramGb) !== 'swap');
  return groupByCatalog(picks);
}

/**
 * Normalized names of what is installed, for "Installed" marks.
 * @param {{ name: string }[]} models
 */
export function installedNameSet(models) {
  return new Set((Array.isArray(models) ? models : []).map((m) => normalizeModelName(m.name)).filter(Boolean));
}

/* Updates */

/**
 * The update check's verdict for one installed model, or null when there is
 * none or the model was pulled again after the check, so the verdict is stale.
 * @param {{ name: string, modifiedAt?: string }} model
 * @param {UpdatesPayload|null|undefined} updates
 * @returns {UpdateState|null}
 */
export function updateStatus(model, updates) {
  const hit = updates?.results?.[model.name];
  if (!hit) return null;
  const checked = timeOf(updates?.checkedAt);
  const modified = timeOf(model.modifiedAt);
  if (checked != null && modified != null && modified > checked) return null;
  return hit.status;
}

/* Auto picks */

/** Catalog groups Auto draws from, in this order. */
const AUTO_GROUPS = ['Small & Fast', 'Powerful', 'Reasoning'];
/** Specialists Auto never takes; MCQ builds are picked by hand. */
const AUTO_SKIP_GROUPS = new Set(['Uncensored', 'Vision', 'MCQ']);

/** Above this many tokens of conversation, Auto prefers a long context. */
export const LARGE_CONTEXT_THRESHOLD = 6000;
const LONG_CONTEXT_TOKENS = 131072;

/** @param {CatalogRow[]} list */
const installedOnly = (list) => (Array.isArray(list) ? list : []).filter((m) => m && m.available !== false);

/**
 * Whether the group or the name says uncensored, for rows without the flag. The
 * same words as UNCENSORED_NAME_RE in backend/src/modelCatalog.js, which flags
 * installs the catalog does not list.
 * @param {{ id?: string, label?: string, group?: string }|null|undefined} item
 */
export function isUncensoredModelRecord(item) {
  const haystack = `${item?.id || ''} ${item?.label || ''} ${item?.group || ''}`.toLowerCase();
  return (
    String(item?.group || '').toLowerCase() === 'uncensored' ||
    /uncensored|abliterat|heretic|dolphin/.test(haystack)
  );
}

/**
 * Embedding models cannot chat. Ollama reports capabilities; without them the
 * name decides.
 * @param {CatalogRow|null|undefined} item
 */
export function isEmbeddingOnly(item) {
  const caps = Array.isArray(item?.capabilities) ? item.capabilities : [];
  if (caps.length) return caps.includes('embedding') && !caps.includes('completion');
  return /embed/i.test(`${item?.id || ''} ${item?.ollamaId || ''}`);
}

/**
 * Installed models Auto may use, best first: catalog order within Small & Fast,
 * Powerful and Reasoning, then the rest that are general chat models.
 * @param {CatalogRow[]} models
 * @returns {CatalogRow[]}
 */
export function autoCandidates(models) {
  const list = installedOnly(models).filter((m) => !isEmbeddingOnly(m));
  const ranked = AUTO_GROUPS.flatMap((g) => list.filter((m) => m.group === g));
  const extras = list.filter((m) =>
    !AUTO_GROUPS.includes(String(m.group || '')) && !AUTO_SKIP_GROUPS.has(String(m.group || ''))
    && m.local !== true && m.uncensored !== true && !isUncensoredModelRecord(m));
  return [...ranked, ...extras];
}

/**
 * The model Auto sends to. Long conversations take the first candidate with a
 * 128K window, else the widest known window. With no candidate, any installed
 * chat model, so Auto never claims nothing is installed.
 * @param {CatalogRow[]} models
 * @param {number} [contextTokens]
 * @returns {CatalogRow|null}
 */
export function pickAutoModel(models, contextTokens = 0) {
  const list = autoCandidates(models);
  if (list.length === 0) return installedOnly(models).find((m) => !isEmbeddingOnly(m)) || null;
  if (Number(contextTokens) > LARGE_CONTEXT_THRESHOLD) {
    const windowOf = (/** @type {CatalogRow} */ m) => Number(m.contextWindow) || 0;
    const long = list.find((m) => windowOf(m) >= LONG_CONTEXT_TOKENS);
    if (long) return long;
    const widest = list.reduce((best, m) => (windowOf(m) > windowOf(best) ? m : best), list[0]);
    if (windowOf(widest) > 0) return widest;
  }
  return list[0];
}

/**
 * The model Uncensored mode forces: the catalog's Uncensored group in order,
 * then anything flagged uncensored, then the name test.
 * @param {CatalogRow[]} models
 * @returns {CatalogRow|null}
 */
export function pickUncensoredModel(models) {
  const list = installedOnly(models);
  return list.find((m) => m.group === 'Uncensored')
    || list.find((m) => m.uncensored === true)
    || list.find((m) => isUncensoredModelRecord(m))
    || null;
}

/* Payloads */

const UPDATE_STATES = ['current', 'update', 'unknown', 'local'];
const INSTALL_KINDS = ['homebrew', 'app', 'script', 'windows', 'unknown'];
const JOB_STATES = ['queued', 'running', 'canceling', 'completed', 'failed', 'canceled'];
const CAPABILITIES = ['tools', 'thinking', 'vision', 'embedding', 'audio'];
export const DOWNLOAD_URL = 'https://ollama.com/download';

/** Discover's capability filters, in display order. */
export const CAPABILITY_FILTERS = Object.freeze([
  { value: 'tools', label: 'Tools' },
  { value: 'thinking', label: 'Thinking' },
  { value: 'vision', label: 'Vision' },
  { value: 'embedding', label: 'Embedding' }
]);

/** @type {Readonly<Record<string, string>>} */
export const CAPABILITY_LABELS = Object.freeze({
  tools: 'Tools', thinking: 'Thinking', vision: 'Vision', embedding: 'Embedding', audio: 'Audio'
});

/** @param {any} raw @returns {InstalledModel} */
function normalizeInstalledModel(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const cat = m.catalog && typeof m.catalog === 'object' && str(m.catalog.id) ? m.catalog : null;
  return {
    name: str(m.name),
    sizeBytes: num(m.sizeBytes),
    digest: str(m.digest),
    modifiedAt: str(m.modifiedAt),
    family: str(m.family),
    paramSize: str(m.paramSize),
    quant: str(m.quant),
    format: str(m.format),
    capabilities: strings(m.capabilities),
    contextWindow: num(m.contextWindow),
    loaded: m.loaded === true,
    catalog: cat ? { id: str(cat.id), label: str(cat.label) || str(cat.id), group: str(cat.group) } : null,
    uncensored: m.uncensored === true,
    local: m.local === true
  };
}

/**
 * Fills every field the pane reads, so a partial payload cannot crash it.
 * @param {any} raw GET /api/models/installed
 * @returns {InstalledPayload}
 */
export function normalizeInstalled(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const rt = p.runtime && typeof p.runtime === 'object' ? p.runtime : {};
  const disk = p.disk && typeof p.disk === 'object' ? p.disk : {};
  const url = str(rt.downloadUrl);
  return {
    runtime: {
      reachable: rt.reachable !== false,
      version: strOrNull(rt.version),
      latest: strOrNull(rt.latest),
      updateAvailable: rt.updateAvailable === true,
      install: INSTALL_KINDS.includes(rt.install) ? rt.install : 'unknown',
      updateCommand: strOrNull(rt.updateCommand),
      downloadUrl: /^https:\/\//i.test(url) ? url : DOWNLOAD_URL
    },
    disk: { path: str(disk.path), freeBytes: num(disk.freeBytes), totalBytes: num(disk.totalBytes) },
    models: Array.isArray(p.models) ? p.models.map(normalizeInstalledModel).filter((m) => m.name) : []
  };
}

/**
 * @param {any} raw GET /api/models/updates
 * @returns {UpdatesPayload}
 */
export function normalizeUpdates(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  /** @type {Record<string, { status: UpdateState, reason: string }>} */
  const results = {};
  const src = p.results && typeof p.results === 'object' ? p.results : {};
  for (const [name, r] of Object.entries(src)) {
    const status = r && typeof r === 'object' && UPDATE_STATES.includes(r.status) ? r.status : null;
    if (status) results[name] = { status, reason: str(r.reason) };
  }
  return { checkedAt: strOrNull(p.checkedAt), goDark: p.goDark === true, results };
}

/** @param {any} raw @returns {LibraryModel} */
function normalizeLibraryModel(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  return {
    name: str(m.name),
    description: str(m.description),
    capabilities: strings(m.capabilities).filter((c) => CAPABILITIES.includes(c)),
    sizes: strings(m.sizes),
    pulls: num(m.pulls),
    tags: num(m.tags),
    updated: strOrNull(m.updated)
  };
}

/**
 * @param {any} raw GET /api/models/library
 * @returns {LibraryPage}
 */
export function normalizeLibrary(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    page: num(p.page) ?? 1,
    hasMore: p.hasMore === true,
    goDark: p.goDark === true,
    stale: p.stale === true,
    results: Array.isArray(p.results) ? p.results.map(normalizeLibraryModel).filter((m) => m.name) : []
  };
}

/** @param {any} raw @returns {LibraryTag} */
function normalizeTag(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  return {
    name: str(t.name),
    tag: str(t.tag) || str(t.name).split(':').pop() || '',
    sizeBytes: num(t.sizeBytes),
    size: str(t.size),
    context: num(t.context),
    input: strings(t.input),
    mlx: t.mlx === true,
    latest: t.latest === true
  };
}

/**
 * @param {any} raw GET /api/models/library/:name/tags
 * @returns {{ name: string, tags: LibraryTag[] }}
 */
export function normalizeTags(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    name: str(p.name),
    tags: Array.isArray(p.tags) ? p.tags.map(normalizeTag).filter((t) => t.name) : []
  };
}

/**
 * @param {any} raw
 * @returns {InstallJob}
 */
export function normalizeJob(raw) {
  const j = raw && typeof raw === 'object' ? raw : {};
  const status = JOB_STATES.includes(j.status) ? j.status : 'running';
  return {
    id: str(j.id),
    modelId: str(j.modelId),
    status,
    pct: num(j.pct),
    message: str(j.message),
    error: str(j.error),
    done: j.done === true || status === 'completed' || status === 'failed' || status === 'canceled',
    completedBytes: num(j.completedBytes),
    totalBytes: num(j.totalBytes),
    bytesPerSec: num(j.bytesPerSec),
    etaSec: num(j.etaSec)
  };
}

/* Requests */

/**
 * Discover's query string for GET /api/models/library.
 * @param {{ query?: string, caps?: string[], fits?: boolean, ramGb?: unknown, order?: string, page?: number }} [opts]
 */
export function libraryQuery({ query = '', caps = [], fits = false, ramGb = null, order = 'popular', page = 1 } = {}) {
  const p = new URLSearchParams();
  const q = String(query || '').trim();
  if (q) p.set('q', q);
  for (const c of caps) if (CAPABILITY_FILTERS.some((f) => f.value === c)) p.append('c', c);
  const s = fits ? fitBucket(ramGb) : null;
  if (s) p.set('s', s);
  p.set('o', order === 'newest' ? 'newest' : 'popular');
  p.set('page', String(Math.max(1, Math.floor(Number(page) || 1))));
  return p.toString();
}

/** @param {string} name */
const enc = (name) => encodeURIComponent(name);

/** @param {{ signal?: AbortSignal }} [opts] @returns {Promise<InstalledPayload>} */
export async function fetchInstalled(opts = {}) {
  return normalizeInstalled(await apiFetch('/api/models/installed', { signal: opts.signal, timeoutMs: 20000 }));
}

/**
 * The cached update check; refresh asks the registry now (never under Go Dark).
 * @param {{ refresh?: boolean, signal?: AbortSignal }} [opts]
 * @returns {Promise<UpdatesPayload>}
 */
export async function fetchUpdates({ refresh = false, signal } = {}) {
  const p = await apiFetch(`/api/models/updates${refresh ? '?refresh=1' : ''}`, { signal, timeoutMs: refresh ? 60000 : 15000 });
  return normalizeUpdates(p);
}

/**
 * @param {Parameters<typeof libraryQuery>[0]} params
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<LibraryPage>}
 */
export async function fetchLibrary(params, opts = {}) {
  return normalizeLibrary(await apiFetch(`/api/models/library?${libraryQuery(params)}`, { signal: opts.signal, timeoutMs: 20000 }));
}

/**
 * A "user/model" name travels as one encoded path segment.
 * @param {string} name
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function fetchLibraryTags(name, opts = {}) {
  return normalizeTags(await apiFetch(`/api/models/library/${enc(name)}/tags`, { signal: opts.signal, timeoutMs: 20000 }));
}

/**
 * Size and existence of a name in the registry, before a pull.
 * @param {string} name
 * @param {{ localOnly?: boolean, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ status: 'found'|'missing'|'invalid'|'unknown', sizeBytes: number|null, size: string }>}
 */
export async function lookupRegistry(name, { localOnly = false, signal } = {}) {
  const q = new URLSearchParams({ id: name });
  if (localOnly) q.set('localOnly', '1');
  const p = await apiFetch(`/api/models/registry-lookup?${q.toString()}`, { signal });
  const status = ['found', 'missing', 'invalid'].includes(p?.status) ? p.status : 'unknown';
  return { status, sizeBytes: num(p?.sizeBytes), size: str(p?.size) };
}

/** @returns {Promise<InstallJob[]>} newest first */
export async function listInstallJobs() {
  const p = await apiFetch('/api/models/install-jobs');
  return Array.isArray(p?.jobs) ? p.jobs.map(normalizeJob).filter((j) => j.id) : [];
}

/** @param {string} id @param {{ signal?: AbortSignal }} [opts] @returns {Promise<InstallJob>} */
export async function getInstallJob(id, opts = {}) {
  const p = await apiFetch(`/api/models/install-jobs/${enc(id)}`, { signal: opts.signal });
  return normalizeJob(p?.job);
}

/**
 * Starts a pull, or an update of an installed name: Ollama fetches only the
 * layers that changed. The backend reuses a running job for the same name.
 * @param {string} name
 * @returns {Promise<InstallJob>}
 */
export async function startInstallJob(name) {
  const p = await apiFetch('/api/models/install-jobs', { method: 'POST', body: { modelId: name } });
  return normalizeJob(p?.job);
}

/** A restarted backend forgets its jobs; Ollama keeps what was downloaded. */
export const JOB_LOST = 'Download interrupted. Retry to resume.';

/**
 * Waits ms, or less if the signal aborts.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Polls one install job until it ends, the signal aborts or the backend loses
 * it. Progress only moves forward, so a re-attached job never jumps back.
 * @param {InstallJob} first
 * @param {object} opts
 * @param {AbortSignal} opts.signal
 * @param {(job: InstallJob) => void} opts.onProgress
 * @param {(id: string, opts: { signal: AbortSignal }) => Promise<InstallJob>} [opts.poll]
 * @param {(err: unknown) => string} [opts.describe]  a failed poll as a sentence
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.retries]   failed polls in a row before giving up
 * @param {(ms: number, signal: AbortSignal) => Promise<void>} [opts.sleep]
 * @returns {Promise<{ status: 'completed'|'failed'|'canceled'|'aborted', error: string }>}
 */
export async function followInstallJob(first, {
  signal, onProgress, poll = getInstallJob, describe = (err) => String(/** @type {any} */ (err)?.message || ''),
  intervalMs = 1000, retries = 5, sleep = wait
}) {
  let job = first;
  let failures = 0;
  let pct = -1;
  while (!signal.aborted) {
    pct = Math.max(pct, job.pct ?? -1);
    onProgress({ ...job, pct: pct >= 0 ? pct : null });
    if (job.done) {
      const status = job.status === 'completed' || job.status === 'canceled' ? job.status : 'failed';
      return { status, error: status === 'failed' ? job.error : '' };
    }
    await sleep(intervalMs, signal);
    if (signal.aborted) break;
    try {
      job = await poll(job.id, { signal });
      failures = 0;
    } catch (err) {
      if (signal.aborted) break;
      if (/not found/i.test(String(/** @type {any} */ (err)?.message || ''))) return { status: 'failed', error: JOB_LOST };
      failures += 1;
      if (failures >= retries) return { status: 'failed', error: describe(err) };
    }
  }
  return { status: 'aborted', error: '' };
}

/** @param {string} id */
export async function cancelInstallJob(id) {
  await apiFetch(`/api/models/install-jobs/${enc(id)}/cancel`, { method: 'POST' });
}

/** @param {string} name */
export async function deleteInstalledModel(name) {
  await apiFetch(`/api/models/${enc(name)}`, { method: 'DELETE', timeoutMs: 30000 });
}
