// @ts-check
// OpenAI-compatible provider adapter (llama-server, compatible APIs)

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:8000/v1';

const LIST_TIMEOUT_MS = 8000;

export async function listOpenAICompatibleModels(input) {
  const base = typeof input === 'string'
    ? (input || OPENAI_BASE_URL)
    : (input?.baseUrl || OPENAI_BASE_URL);
  const apiKey = typeof input === 'object' && input !== null ? input.apiKey : '';
  try {
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
    // A stalled host must not hang the model picker.
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map(m => ({
      id: m.id,
      name: m.id,
      owned_by: m.owned_by || 'unknown'
    }));
  } catch (error) {
    console.error('Failed to list OpenAI-compatible models:', error.message);
    return [];
  }
}

// Sampling parameters OpenAI-compatible servers (llama-server, vLLM, LM Studio, KoboldCpp)
// accept. Values are clamped to safe ranges; unknown keys are dropped.
const OPENAI_PARAM_SPEC = {
  top_p: { min: 0, max: 1 },
  top_k: { min: 0, max: 500, int: true },
  min_p: { min: 0, max: 1 },                 // llama.cpp / vLLM extension
  typical_p: { min: 0, max: 1 },
  repeat_penalty: { min: 0, max: 4 },        // llama.cpp extension
  presence_penalty: { min: -2, max: 2 },
  frequency_penalty: { min: -2, max: 2 },
  seed: { min: 0, max: 2147483647, int: true },
  n_predict: { min: -1, max: 131072, int: true } // llama.cpp alias for max tokens
};

// OpenAI, Groq and vLLM read this for reasoning models; "none" switches it off.
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export function sanitizeOpenAIParams(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [key, spec] of Object.entries(OPENAI_PARAM_SPEC)) {
    const value = raw[key];
    if (value == null || value === '') continue;
    let num = Number(value);
    if (!isFinite(num)) continue;
    if (spec.int) num = Math.round(num);
    out[key] = Math.min(spec.max, Math.max(spec.min, num));
  }
  // Pass-through complex fields the server validates itself.
  if (Array.isArray(raw.stop) && raw.stop.length) out.stop = raw.stop.slice(0, 8).map(String);
  else if (typeof raw.stop === 'string' && raw.stop) out.stop = [raw.stop];
  if (raw.response_format && typeof raw.response_format === 'object') out.response_format = raw.response_format;
  if (Array.isArray(raw.tools) && raw.tools.length) out.tools = raw.tools;
  if (raw.tool_choice != null) out.tool_choice = raw.tool_choice;
  if (raw.grammar && typeof raw.grammar === 'string') out.grammar = raw.grammar; // llama.cpp GBNF
  if (REASONING_EFFORTS.has(raw.reasoning_effort)) out.reasoning_effort = raw.reasoning_effort;
  return out;
}

// Reasoning tokens count toward max_completion_tokens, so a cap sized for the
// answer could be spent before any text appears. The cap gets room for the effort
// on top; billing follows the tokens actually used.
const REASONING_HEADROOM = { none: 0, minimal: 1024, low: 4096, medium: 16384, high: 32768, xhigh: 65536 };

/**
 * OpenAI's own API runs GPT-5 and later and the o-series as reasoning models:
 * they take max_completion_tokens, and reject temperature and top_p unless
 * reasoning_effort is "none". Groq, Cerebras, OpenRouter and local servers
 * keep max_tokens and sampling.
 * @param {{ provider?: string, baseUrl?: string, model?: string }} args
 * @returns {boolean}
 */
export function isOpenAIReasoningRequest({ provider, baseUrl, model }) {
  let host = '';
  try { host = new URL(String(baseUrl || '')).hostname.toLowerCase(); } catch { /* not a URL */ }
  if (provider !== 'openai' && host !== 'api.openai.com') return false;
  // Fine-tunes keep the base id after "ft:".
  const m = /^(?:ft:)?(?:gpt-(\d+)|o\d)/i.exec(String(model || '').trim());
  if (!m) return false;
  return m[1] === undefined || Number(m[1]) >= 5;
}

export async function streamOpenAICompatibleChat({ baseUrl, apiKey, model, messages, signal, onToken, temperature, maxTokens, params, provider = '', providerLabel = 'OpenAI-compatible' }) {
  const base = baseUrl || OPENAI_BASE_URL;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const extra = sanitizeOpenAIParams(params);
  const reasoning = isOpenAIReasoningRequest({ provider, baseUrl: base, model });
  // Sampling is only accepted there with reasoning switched off.
  const sampling = !reasoning || extra.reasoning_effort === 'none';
  if (!sampling) delete extra.top_p;

  const payload = {
    model,
    // OpenAI-compatible vision: a message with images becomes a content array of
    // a text part plus image_url parts (data: URLs). Plain text stays a string.
    messages: messages.map(m => (Array.isArray(m.images) && m.images.length
      ? {
        role: m.role,
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.images.map(im => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } }))
        ]
      }
      : { role: m.role, content: m.content })),
    stream: true,
    ...(temperature != null && sampling ? { temperature } : {}),
    ...(maxTokens != null
      ? (reasoning
        ? { max_completion_tokens: maxTokens + (REASONING_HEADROOM[extra.reasoning_effort] ?? REASONING_HEADROOM.medium) }
        : { max_tokens: maxTokens })
      : {}),
    ...extra,
  };

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      let detail = '';
      try {
        const parsed = JSON.parse(bodyText || '{}');
        detail =
          parsed?.error?.message ||
          parsed?.message ||
          (Array.isArray(parsed) ? (parsed[0]?.error?.message || parsed[0]?.message || '') : '');
      } catch {
        detail = bodyText || '';
      }
      if (res.status === 429 && !detail) {
        detail = 'Rate limit or quota exceeded for this API key.';
      }
      throw new Error(`${providerLabel} API error: ${res.status}${detail ? ` - ${detail}` : ''}`);
    }

    if (!res.body) throw new Error(`${providerLabel} returned no response body.`);
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
        if (!line.trim() || line.trim() === '[DONE]') continue;
        if (!line.startsWith('data: ')) continue;

        let json;
        try {
          json = JSON.parse(line.slice(6));
        } catch {
          // Partial frame: the next chunk will complete it.
          continue;
        }
        // Mid-generation failures arrive as a `data: {"error":...}` frame on a 200
        // response; throw so the route does not save an empty reply as success.
        if (json.error) {
          const detail = json.error?.message || json.error;
          throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
        }
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          onToken(delta);
        }
      }
    }
  } catch (error) {
    // Propagate real failures (aborts are user-initiated) so the stream handler
    // sends an `error` event and rolls back instead of saving the error as reply.
    if (error.name === 'AbortError') return;
    throw error;
  }
}
