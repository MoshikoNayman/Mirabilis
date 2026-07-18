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

export async function streamOllamaChat({ baseUrl, model, messages, signal, onToken, onStats, temperature, maxTokens, options: extraOptions }) {
  const base = baseUrl || OLLAMA_BASE_URL;
  // Merge every tuning knob into a single Ollama `options` object. Explicit
  // extraOptions (the Inference Cockpit profile) take precedence; temperature
  // and maxTokens stay as convenience params. A single merged object avoids the
  // old double-spread where the second `options` clobbered the first.
  const options = {};
  if (temperature != null) options.temperature = temperature;
  if (maxTokens != null) options.num_predict = maxTokens;
  if (extraOptions && typeof extraOptions === 'object') {
    for (const [key, value] of Object.entries(extraOptions)) {
      if (value != null) options[key] = value;
    }
  }
  const payload = {
    model,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content
    })),
    stream: true,
    ...(Object.keys(options).length ? { options } : {}),
  };

  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      throw new Error(`Ollama API error: ${res.status}`);
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
