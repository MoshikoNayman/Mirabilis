// @ts-check

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

// /api/tags is about 500 bytes a model and /api/show tens of KB. A body far
// past that is a broken host, not a model list.
const MAX_TAGS_BYTES = 4 * 1024 * 1024;
const MAX_SHOW_BYTES = 8 * 1024 * 1024;

/**
 * Parse a JSON body, refusing one larger than maxBytes.
 * @param {Response} res
 * @param {number} maxBytes
 */
async function readJson(res, maxBytes) {
  if (Number(res.headers.get('content-length')) > maxBytes) throw new Error('response too large');
  if (!res.body) return JSON.parse(await res.text());
  const reader = res.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** @param {unknown} value @returns {string | null} ISO time, or null when unparseable */
function toIso(value) {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export async function listOllamaModels(baseUrl) {
  const base = baseUrl || OLLAMA_BASE_URL;
  try {
    // Bounded: a host that accepts the connection but never answers would
    // otherwise hang the model picker until the OS timeout.
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await readJson(res, MAX_TAGS_BYTES);
    const models = Array.isArray(data?.models) ? data.models : [];
    return models.filter((m) => m && typeof m.name === 'string' && m.name).map(m => ({
      id: m.name,
      name: m.name,
      size: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : 'unknown',
      sizeBytes: typeof m.size === 'number' ? m.size : null,
      paramSize: m.details?.parameter_size || null,
      quant: m.details?.quantization_level || null,
      // sha256 of the local manifest, 64 hex with no prefix. The registry
      // reports the same value, so update checks compare the two.
      digest: typeof m.digest === 'string' && m.digest ? m.digest : null,
      modifiedAt: toIso(m.modified_at),
      family: m.details?.family || null,
      format: m.details?.format || null
    }));
  } catch (error) {
    console.error('Failed to list Ollama models:', error.message);
    return [];
  }
}

// Context window and parameter count from /api/show, used by autoTune to size
// num_ctx. Static per model, so cached.
const _modelInfoCache = new Map();
// Only successes are cached permanently. Failures get a short TTL so a startup
// blip does not stick and a down daemon is not hit on every keystroke.
const NEGATIVE_TTL_MS = 10_000;
const METADATA_TIMEOUT_MS = 3000;
/** @type {Map<string, number>} */
const _modelInfoFailedAt = new Map();

/**
 * Facts from /api/show. Never throws; a failure answers with nulls and [].
 * @param {string | undefined} baseUrl
 * @param {string} model
 * @param {{ digest?: string | null }} [opts] the /api/tags digest, so a model
 *   that was pulled again gets fresh facts instead of the cached ones
 * @returns {Promise<import('../types.js').OllamaModelInfo>}
 */
export async function getOllamaModelInfo(baseUrl, model, { digest = null } = {}) {
  const base = baseUrl || OLLAMA_BASE_URL;
  const nameKey = `${base}::${model}`;
  const key = digest ? `${nameKey}@${digest}` : nameKey;
  if (_modelInfoCache.has(key)) return _modelInfoCache.get(key);
  /** @type {import('../types.js').OllamaModelInfo} */
  const unknown = { contextWindow: null, paramCount: null, capabilities: [], vision: false };

  const failedAt = _modelInfoFailedAt.get(key);
  if (failedAt != null && Date.now() - failedAt < NEGATIVE_TTL_MS) return unknown;

  try {
    const res = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      // Metadata sits on the send path; a stalled host must not delay the first token.
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS)
    });
    if (!res.ok) {
      _modelInfoFailedAt.set(key, Date.now());
      return unknown;
    }
    const data = await readJson(res, MAX_SHOW_BYTES);
    const info = data.model_info || {};
    /** @type {number | null} */
    let ctx = null;
    for (const [k, v] of Object.entries(info)) {
      if (k.endsWith('.context_length')) { ctx = Number(v) || null; break; }
    }
    const caps = Array.isArray(data.capabilities) ? data.capabilities : [];
    /** @type {import('../types.js').OllamaModelInfo} */
    const out = {
      contextWindow: ctx,
      paramCount: Number(info['general.parameter_count']) || null,
      capabilities: caps,
      vision: caps.includes('vision')
    };
    _modelInfoCache.set(key, out);
    // Name-only callers (the send path) then see the facts of the current pull.
    if (key !== nameKey) _modelInfoCache.set(nameKey, out);
    _modelInfoFailedAt.delete(key);
    return out;
  } catch {
    // Unreachable, timed out, or malformed: remember the failure briefly, but
    // never as a permanent answer.
    _modelInfoFailedAt.set(key, Date.now());
    return unknown;
  }
}

// Gates the retry ladder: a miss here is a hard failure. Ollama says "requires
// more system memory than is available", and an OOM-killed runner reports only
// "signal: killed" or "runner process has terminated".
const OOM_RE = new RegExp([
  'out of memory', 'unable to allocate', 'failed to allocate', 'cudamalloc',
  'insufficient memory', 'not enough memory', '\\bvram\\b',
  'requires more system memory', 'than is available',
  'signal: killed', 'runner process has terminated', 'exit status 137'
].join('|'), 'i');

// Options that fit, per base+model, so each message does not repeat the failed loads.
/** @type {Map<string, Record<string, any>>} */
const _fittedOptions = new Map();

/** Options known to have worked for this model, or null. */
export function getFittedOptions(baseUrl, model) {
  return _fittedOptions.get(`${baseUrl || OLLAMA_BASE_URL}::${model}`) || null;
}

/** Test seam: forget what we learned about which options fit. */
export function clearFittedOptions() {
  _fittedOptions.clear();
}

export async function streamOllamaChat({ baseUrl, model, messages, signal, onToken, onStats, onNotice, temperature, maxTokens, keepAlive, options: extraOptions }) {
  const base = baseUrl || OLLAMA_BASE_URL;
  // Keep the model resident instead of Ollama's default 5-minute idle unload, so a
  // reply after a pause does not pay a full cold reload. Default 30m; -1 = never unload.
  const keep_alive = keepAlive != null ? keepAlive : '30m';
  // extraOptions (Cockpit profile, auto-tune) override temperature and maxTokens.
  /** @type {Record<string, any>} */
  const baseOptions = {};
  if (temperature != null) baseOptions.temperature = temperature;
  if (maxTokens != null) baseOptions.num_predict = maxTokens;
  if (extraOptions && typeof extraOptions === 'object') {
    for (const [key, value] of Object.entries(extraOptions)) {
      if (value != null) baseOptions[key] = value;
    }
  }

  // OOM ladder: halve num_ctx with low_vram, then fall back to CPU.
  function reduceOptions(opts, step) {
    const next = { ...opts, low_vram: true };
    const curCtx = Number(next.num_ctx) || 4096;
    if (step === 1) { next.num_ctx = Math.max(2048, Math.floor(curCtx / 2)); next.num_batch = 256; }
    else { next.num_ctx = 2048; next.num_gpu = 0; next.num_batch = 128; }
    return next;
  }

  async function attempt(opts) {
    const payload = {
      model,
      // Ollama wants raw base64 images, without a data: prefix.
      messages: messages.map(m => (Array.isArray(m.images) && m.images.length
        ? { role: m.role, content: m.content, images: m.images.map(im => im.data) }
        : { role: m.role, content: m.content })),
      stream: true,
      keep_alive,
      ...(Object.keys(opts).length ? { options: opts } : {}),
    };
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      const err = /** @type {Error & { isOom?: boolean }} */ (new Error(`Ollama API error: ${res.status}${body ? ' - ' + body.slice(0, 200) : ''}`));
      err.isOom = OOM_RE.test(body);
      throw err;
    }
    return res;
  }

  try {
    const fitKey = `${base}::${model}`;
    // Fitted values are a cap: autoTune sends num_ctx on every request, so as a
    // default they would always lose. Smaller requests are left alone.
    const fitted = _fittedOptions.get(fitKey);
    let opts = { ...baseOptions };
    if (fitted) {
      if (fitted.num_ctx != null && (opts.num_ctx == null || opts.num_ctx > fitted.num_ctx)) {
        opts.num_ctx = fitted.num_ctx;
      }
      if (fitted.num_batch != null && (opts.num_batch == null || opts.num_batch > fitted.num_batch)) {
        opts.num_batch = fitted.num_batch;
      }
      // Required just to load the model, so always applied.
      if (fitted.num_gpu === 0) opts.num_gpu = 0;
      if (fitted.low_vram) opts.low_vram = true;
    }
    let res;
    let reduced = false;
    for (let step = 0; step <= 2; step += 1) {
      try {
        res = await attempt(opts);
        break;
      } catch (e) {
        if (e && e.isOom && step < 2) {
          opts = reduceOptions(opts, step + 1);
          reduced = true;
          if (typeof onNotice === 'function') {
            onNotice(`Reduced to fit memory: num_ctx ${opts.num_ctx}${opts.num_gpu === 0 ? ', CPU offload' : ', low VRAM'}.`);
          }
          continue;
        }
        throw e;
      }
    }
    // Keep only the memory knobs; sampling settings stay per-request.
    if (reduced) {
      const { num_ctx, num_gpu, num_batch, low_vram } = opts;
      _fittedOptions.set(fitKey, JSON.parse(JSON.stringify({ num_ctx, num_gpu, num_batch, low_vram })));
    }

    if (!res.body) throw new Error('Ollama returned no response body.');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        let json;
        try {
          json = JSON.parse(line);
        } catch {
          // Partial or non-JSON line: the next chunk will complete it.
          continue;
        }
        // Mid-generation failures arrive as an `error` field inside a 200 stream.
        // Throw, or the route stores an empty reply as a success.
        if (json.error) {
          const err = /** @type {Error & { isOom?: boolean }} */ (new Error(String(json.error)));
          err.isOom = OOM_RE.test(String(json.error));
          throw err;
        }
        if (json.message?.content) {
          onToken(json.message.content);
        }
        // The final chunk carries exact metrics for the Performance Receipt.
        if (json.done === true && typeof onStats === 'function') {
          onStats({
            evalCount: typeof json.eval_count === 'number' ? json.eval_count : null,
            evalDurationNs: typeof json.eval_duration === 'number' ? json.eval_duration : null,
            promptEvalCount: typeof json.prompt_eval_count === 'number' ? json.prompt_eval_count : null,
            promptEvalDurationNs: typeof json.prompt_eval_duration === 'number' ? json.prompt_eval_duration : null,
            loadDurationNs: typeof json.load_duration === 'number' ? json.load_duration : null,
            totalDurationNs: typeof json.total_duration === 'number' ? json.total_duration : null
          });
        }
      }
    }
  } catch (error) {
    // Aborts come from the user. Real failures must propagate so the handler
    // emits `error` and rolls back the empty assistant message.
    if (error.name === 'AbortError') return;
    throw error;
  }
}
