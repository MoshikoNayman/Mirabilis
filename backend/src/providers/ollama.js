// @ts-check
// Ollama provider adapter for local LLM chat

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

export async function listOllamaModels(baseUrl) {
  const base = baseUrl || OLLAMA_BASE_URL;
  try {
    // Bounded: a host that accepts the connection but never answers would
    // otherwise hang the model picker until the OS timeout.
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(m => ({
      id: m.name,
      name: m.name,
      size: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : 'unknown',
      sizeBytes: typeof m.size === 'number' ? m.size : null,
      paramSize: m.details?.parameter_size || null,
      quant: m.details?.quantization_level || null
    }));
  } catch (error) {
    console.error('Failed to list Ollama models:', error.message);
    return [];
  }
}

// Per-model runtime facts from Ollama's /api/show: the model's TRUE context window
// and parameter count, used by autoTune to size num_ctx. Cached (static per model).
const _modelInfoCache = new Map();
// A failed probe used to be cached exactly like a successful one, so one blip
// while the daemon was starting poisoned the entry for the process lifetime:
// every later request fell back to a default context window and reported the
// model as non-vision, silently disabling image input. Only successes are cached
// permanently; failures get a short negative TTL so a genuinely down daemon is
// not hammered on every keystroke.
const NEGATIVE_TTL_MS = 10_000;
const METADATA_TIMEOUT_MS = 3000;
/** @type {Map<string, number>} */
const _modelInfoFailedAt = new Map();

export async function getOllamaModelInfo(baseUrl, model) {
  const base = baseUrl || OLLAMA_BASE_URL;
  const key = `${base}::${model}`;
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
      // Metadata must never delay time-to-first-token. Without a timeout an
      // unreachable-but-accepting host blocks the send path until the OS gives up.
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS)
    });
    if (!res.ok) {
      _modelInfoFailedAt.set(key, Date.now());
      return unknown;
    }
    const data = await res.json();
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
    _modelInfoFailedAt.delete(key);
    return out;
  } catch {
    // Unreachable, timed out, or malformed: remember the failure briefly, but
    // never as a permanent answer.
    _modelInfoFailedAt.set(key, Date.now());
    return unknown;
  }
}

// Memory-pressure detection. This gates the whole retry ladder, so a message
// Ollama actually emits but this pattern misses means the user gets a hard
// failure where a smaller context would have worked.
//
// The second group is the wording Ollama really uses in practice: it reports
// "model requires more system memory than is available", and a runner killed by
// the OS OOM-killer surfaces as "signal: killed" or "runner process has
// terminated" with no memory wording at all.
const OOM_RE = new RegExp([
  'out of memory', 'unable to allocate', 'failed to allocate', 'cudamalloc',
  'insufficient memory', 'not enough memory', '\\bvram\\b',
  'requires more system memory', 'than is available',
  'signal: killed', 'runner process has terminated', 'exit status 137'
].join('|'), 'i');

// Remember the options that actually fit, per base+model. Without this the
// ladder is re-walked from the top on every single message: the user pays two
// failed loads before each reply on a machine that has already proven it cannot
// hold the default context.
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
  // Merge every tuning knob into a single Ollama `options` object. Explicit
  // extraOptions (the Inference Cockpit profile / auto-tune) take precedence;
  // temperature and maxTokens stay as convenience params.
  /** @type {Record<string, any>} */
  const baseOptions = {};
  if (temperature != null) baseOptions.temperature = temperature;
  if (maxTokens != null) baseOptions.num_predict = maxTokens;
  if (extraOptions && typeof extraOptions === 'object') {
    for (const [key, value] of Object.entries(extraOptions)) {
      if (value != null) baseOptions[key] = value;
    }
  }

  // On an out-of-memory / allocation failure, degrade gracefully instead of
  // hard-failing the whole message: shrink num_ctx and enable low_vram, then fall
  // all the way back to CPU. Each rung is only tried when the error looks like OOM.
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
      // Ollama vision: a message can carry `images: [base64, ...]` (raw base64,
      // no data: prefix). Only attached when the message actually has images.
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
    // Apply what we already learned fits this model on this machine as a CAP,
    // not as a default. A plain spread would be useless here: autoTune supplies
    // num_ctx on every request, so the incoming value would always win and the
    // ladder would be re-walked forever. Capping is the honest reading of the
    // evidence, since we watched this machine fail to load the larger value.
    // A request asking for LESS than the known-good value is left alone.
    const fitted = _fittedOptions.get(fitKey);
    let opts = { ...baseOptions };
    if (fitted) {
      if (fitted.num_ctx != null && (opts.num_ctx == null || opts.num_ctx > fitted.num_ctx)) {
        opts.num_ctx = fitted.num_ctx;
      }
      if (fitted.num_batch != null && (opts.num_batch == null || opts.num_batch > fitted.num_batch)) {
        opts.num_batch = fitted.num_batch;
      }
      // These two are not "sizes" but fallbacks that were required to load at all.
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
    // Remember a successful reduction so the next message starts from what fit
    // rather than paying the failed loads again. Only the memory-shaped knobs
    // are retained; sampling settings stay per-request.
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
        // Ollama reports a large class of mid-generation failures (runner
        // killed, prompt longer than the context, model unloaded) as an `error`
        // field INSIDE a 200 response stream. Dropping that frame ended the
        // stream with empty text, which the route then persisted as a
        // successful empty reply. Fail loudly instead.
        if (json.error) {
          const err = /** @type {Error & { isOom?: boolean }} */ (new Error(String(json.error)));
          err.isOom = OOM_RE.test(String(json.error));
          throw err;
        }
        if (json.message?.content) {
          onToken(json.message.content);
        }
        // Ollama's final chunk carries exact inference metrics. These used to
        // be discarded; surface them so the Performance Receipt can show real
        // tokens/sec and time-to-first-token rather than a client estimate.
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
    // Aborts are user-initiated (stop button / navigation) - swallow them.
    // Real failures must propagate so the stream handler emits an `error` event
    // and rolls back the empty assistant message, instead of persisting the
    // error text as if the model had said it.
    if (error.name === 'AbortError') return;
    throw error;
  }
}
