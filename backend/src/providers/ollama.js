// Ollama provider adapter for local LLM chat

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

export async function listOllamaModels(baseUrl) {
  const base = baseUrl || OLLAMA_BASE_URL;
  try {
    const res = await fetch(`${base}/api/tags`);
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
export async function getOllamaModelInfo(baseUrl, model) {
  const base = baseUrl || OLLAMA_BASE_URL;
  const key = `${base}::${model}`;
  if (_modelInfoCache.has(key)) return _modelInfoCache.get(key);
  let out = { contextWindow: null, paramCount: null, capabilities: [], vision: false };
  try {
    const res = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });
    if (res.ok) {
      const data = await res.json();
      const info = data.model_info || {};
      let ctx = null;
      for (const [k, v] of Object.entries(info)) {
        if (k.endsWith('.context_length')) { ctx = Number(v) || null; break; }
      }
      const caps = Array.isArray(data.capabilities) ? data.capabilities : [];
      out = {
        contextWindow: ctx,
        paramCount: Number(info['general.parameter_count']) || null,
        capabilities: caps,
        vision: caps.includes('vision')
      };
    }
  } catch {
    // best effort - autoTune falls back to a default window
  }
  _modelInfoCache.set(key, out);
  return out;
}

const OOM_RE = /out of memory|unable to allocate|failed to allocate|cudamalloc|insufficient memory|not enough memory|\bvram\b/i;

export async function streamOllamaChat({ baseUrl, model, messages, signal, onToken, onStats, onNotice, temperature, maxTokens, keepAlive, options: extraOptions }) {
  const base = baseUrl || OLLAMA_BASE_URL;
  // Keep the model resident instead of Ollama's default 5-minute idle unload, so a
  // reply after a pause does not pay a full cold reload. Default 30m; -1 = never unload.
  const keep_alive = keepAlive != null ? keepAlive : '30m';
  // Merge every tuning knob into a single Ollama `options` object. Explicit
  // extraOptions (the Inference Cockpit profile / auto-tune) take precedence;
  // temperature and maxTokens stay as convenience params.
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
      const err = new Error(`Ollama API error: ${res.status}${body ? ' - ' + body.slice(0, 200) : ''}`);
      err.isOom = OOM_RE.test(body);
      throw err;
    }
    return res;
  }

  try {
    let opts = baseOptions;
    let res;
    for (let step = 0; step <= 2; step += 1) {
      try {
        res = await attempt(opts);
        break;
      } catch (e) {
        if (e && e.isOom && step < 2) {
          opts = reduceOptions(opts, step + 1);
          if (typeof onNotice === 'function') {
            onNotice(`Reduced to fit memory: num_ctx ${opts.num_ctx}${opts.num_gpu === 0 ? ', CPU offload' : ', low VRAM'}.`);
          }
          continue;
        }
        throw e;
      }
    }

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
        try {
          const json = JSON.parse(line);
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
        } catch {
          // Ignore JSON parse errors for partial lines
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
