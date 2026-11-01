// @ts-check
// Asks the Ollama registry whether a model exists and how big it is, before any pull.

const REGISTRY = 'https://registry.ollama.ai/v2';
const MANIFEST_ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json';
const TIMEOUT_MS = 8000;

/** Same shape the pull route enforces; nothing else is worth a network call. */
const SAFE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,99}$/i;

/**
 * Split a model reference into registry path and tag. Bare names go under
 * library/, as the daemon assumes, so a name that resolves here pulls.
 *
 * @param {string} modelId
 * @returns {{ repo: string, tag: string } | null}
 */
export function parseModelRef(modelId) {
  const raw = String(modelId || '').trim().toLowerCase();
  if (!raw || !SAFE_MODEL_ID.test(raw)) return null;
  const colon = raw.lastIndexOf(':');
  const slash = raw.lastIndexOf('/');
  const hasTag = colon > slash;
  const name = hasTag ? raw.slice(0, colon) : raw;
  const tag = hasTag ? raw.slice(colon + 1) : 'latest';
  if (!name || !tag) return null;
  const repo = name.includes('/') ? name : `library/${name}`;
  return { repo, tag };
}

/** Human-readable size, matching the style used in the catalog. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
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

  try {
    const res = await fetchImpl(`${REGISTRY}/${ref.repo}/manifests/${encodeURIComponent(ref.tag)}`, {
      headers: { Accept: MANIFEST_ACCEPT },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.status === 404) {
      return { status: 'missing', reason: 'No model with that name and tag in the registry.' };
    }
    if (!res.ok) {
      return { status: 'unknown', reason: `The registry answered ${res.status}.` };
    }
    const manifest = await res.json();
    const layers = Array.isArray(manifest?.layers) ? manifest.layers : [];
    const sizeBytes = layers.reduce((sum, l) => sum + (Number(l?.size) || 0), 0);
    return { status: 'found', sizeBytes, size: formatSize(sizeBytes) };
  } catch {
    // Offline, slow, blocked: say so rather than claiming the model is gone.
    return { status: 'unknown', reason: 'Could not reach the registry.' };
  }
}
