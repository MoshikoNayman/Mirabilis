// @ts-check
// Asks the Ollama registry whether a model exists, how big it is, and which
// manifest it serves now, before any pull and for update checks.

import { createHash } from 'node:crypto';

export const REGISTRY_HOST = 'registry.ollama.ai';
const REGISTRY = `https://${REGISTRY_HOST}/v2`;
const MANIFEST_ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json';
const TIMEOUT_MS = 8000;
/** A manifest is about a kilobyte; anything near this is not one. */
const MAX_MANIFEST_BYTES = 256 * 1024;

/** Same shape the pull route enforces; nothing else is worth a network call. */
const SAFE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,99}$/i;
const DIGEST_RE = /^[0-9a-f]{64}$/;

/** @typedef {{ host: string, repo: string, tag: string }} ModelRef */

/**
 * Split a model reference into registry host, path and tag, the way the daemon
 * reads it: model, namespace/model, or host/namespace/model. Bare names go under
 * library/, so a name that resolves here pulls. hf.co/user/repo keeps its own
 * host and never resolves against registry.ollama.ai.
 *
 * @param {string} modelId
 * @returns {ModelRef | null}
 */
export function parseModelRef(modelId) {
  const raw = String(modelId || '').trim().toLowerCase();
  if (!raw || !SAFE_MODEL_ID.test(raw) || raw.includes('..')) return null;
  const colon = raw.lastIndexOf(':');
  const slash = raw.lastIndexOf('/');
  const hasTag = colon > slash;
  const name = hasTag ? raw.slice(0, colon) : raw;
  const tag = hasTag ? raw.slice(colon + 1) : 'latest';
  if (!name || !tag) return null;
  const parts = name.split('/');
  if (parts.length > 3 || parts.some((p) => !p)) return null;
  const host = parts.length === 3 ? /** @type {string} */ (parts.shift()) : REGISTRY_HOST;
  const repo = parts.length === 1 ? `library/${parts[0]}` : parts.join('/');
  return { host, repo, tag };
}

/** True when the daemon would pull this name from registry.ollama.ai. @param {ModelRef | null} ref */
export function isOllamaRegistryRef(ref) {
  return !!ref && ref.host === REGISTRY_HOST;
}

/** Human-readable size, matching the style used in the catalog. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

/** A 64-hex sha256, without the "sha256:" prefix, or '' when it is not one. */
export function normalizeDigest(value) {
  const hex = String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
  return DIGEST_RE.test(hex) ? hex : '';
}

/**
 * Read a response body, refusing to hold more than maxBytes of it.
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
export async function readBodyCapped(res, maxBytes) {
  const tooLarge = () => Object.assign(new Error(`Response larger than ${maxBytes} bytes.`), { code: 'TOO_LARGE' });
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** @param {ModelRef} ref */
function manifestUrl(ref) {
  return `${REGISTRY}/${ref.repo}/manifests/${encodeURIComponent(ref.tag)}`;
}

/**
 * Look a model up in the registry. Never throws: a failed lookup returns
 * "unknown", not "missing", so it cannot block installing a real model.
 *
 * @param {string} modelId
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ status: 'found'|'missing'|'invalid'|'unknown', sizeBytes?: number, size?: string, reason?: string }>}
 */
export async function lookupModel(modelId, { fetchImpl = fetch } = {}) {
  const ref = parseModelRef(modelId);
  if (!ref) return { status: 'invalid', reason: 'That is not a valid model name.' };
  // Another host (hf.co) serves its own manifests; asking ours would say "missing".
  if (!isOllamaRegistryRef(ref)) return { status: 'unknown', reason: 'Hosted outside the Ollama registry.' };

  try {
    const res = await fetchImpl(manifestUrl(ref), {
      headers: { Accept: MANIFEST_ACCEPT },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.status === 404) {
      return { status: 'missing', reason: 'No model with that name and tag in the registry.' };
    }
    if (!res.ok) {
      return { status: 'unknown', reason: `The registry answered ${res.status}.` };
    }
    const manifest = JSON.parse((await readBodyCapped(res, MAX_MANIFEST_BYTES)).toString('utf8'));
    const layers = Array.isArray(manifest?.layers) ? manifest.layers : [];
    const sizeBytes = layers.reduce((sum, l) => sum + (Number(l?.size) || 0), 0);
    return { status: 'found', sizeBytes, size: formatSize(sizeBytes) };
  } catch {
    // Offline, slow, blocked: say so rather than claiming the model is gone.
    return { status: 'unknown', reason: 'Could not reach the registry.' };
  }
}

/**
 * The manifest digest the registry serves for a model, without downloading the
 * model. It equals the digest Ollama's /api/tags reports for an up-to-date copy.
 * Never throws.
 *
 * @param {string} modelId
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: 'found', digest: string } | { status: 'missing'|'invalid'|'unknown', reason: string }>}
 */
export async function headDigest(modelId, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const ref = parseModelRef(modelId);
  if (!ref) return { status: 'invalid', reason: 'Not a valid model name' };
  if (!isOllamaRegistryRef(ref)) return { status: 'unknown', reason: 'Not from the Ollama library' };
  const url = manifestUrl(ref);
  // Node's own User-Agent on purpose: an "ollama/..." one gets a 401 asking for signed auth.
  const init = () => ({ headers: { Accept: MANIFEST_ACCEPT }, signal: AbortSignal.timeout(timeoutMs) });
  try {
    const head = await fetchImpl(url, { ...init(), method: 'HEAD' });
    if (head.status === 404) return { status: 'missing', reason: 'No longer in the library' };
    if (!head.ok) return { status: 'unknown', reason: `Registry answered ${head.status}` };
    const fromHeader = normalizeDigest(head.headers.get('ollama-content-digest'))
      || normalizeDigest(head.headers.get('docker-content-digest'));
    if (fromHeader) return { status: 'found', digest: fromHeader };

    // No digest header: hash the manifest itself, which is what Ollama does locally.
    const res = await fetchImpl(url, init());
    if (res.status === 404) return { status: 'missing', reason: 'No longer in the library' };
    if (!res.ok) return { status: 'unknown', reason: `Registry answered ${res.status}` };
    const body = await readBodyCapped(res, MAX_MANIFEST_BYTES);
    return { status: 'found', digest: createHash('sha256').update(body).digest('hex') };
  } catch {
    return { status: 'unknown', reason: 'Registry unreachable' };
  }
}
