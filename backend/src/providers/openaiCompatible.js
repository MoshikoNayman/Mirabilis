// OpenAI-compatible provider adapter (llama-server, compatible APIs)

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:8000/v1';

export async function listOpenAICompatibleModels(input) {
  const base = typeof input === 'string'
    ? (input || OPENAI_BASE_URL)
    : (input?.baseUrl || OPENAI_BASE_URL);
  const apiKey = typeof input === 'object' && input !== null ? input.apiKey : '';
  try {
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
    const res = await fetch(`${base}/models`, { headers });
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

// The full sampling/behaviour parameter set an OpenAI-compatible server (llama.cpp
// llama-server, vLLM, LM Studio, KoboldCpp) understands. Previously only temperature
// and max_tokens were forwarded, so grammar/JSON mode, stop sequences, seed, nucleus
// sampling, penalties, and tools were unreachable even against a capable local server.
// Values are coerced to safe ranges; unknown keys are dropped.
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
  return out;
}

export async function streamOpenAICompatibleChat({ baseUrl, apiKey, model, messages, signal, onToken, temperature, maxTokens, params, providerLabel = 'OpenAI-compatible' }) {
  const base = baseUrl || OPENAI_BASE_URL;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const payload = {
    model,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content
    })),
    stream: true,
    ...(temperature != null ? { temperature } : {}),
    ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
    ...sanitizeOpenAIParams(params),
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

        try {
          const json = JSON.parse(line.slice(6));
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            onToken(delta);
          }
        } catch {
          // Ignore JSON parse errors for partial lines
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
