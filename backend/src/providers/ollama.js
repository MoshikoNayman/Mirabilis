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
      size: m.size ? `${(m.size / 1e9).toFixed(1)} GB` : 'unknown'
    }));
  } catch (error) {
    console.error('Failed to list Ollama models:', error.message);
    return [];
  }
}

export async function streamOllamaChat({ baseUrl, model, messages, signal, onToken, temperature, maxTokens }) {
  const base = baseUrl || OLLAMA_BASE_URL;
  const payload = {
    model,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content
    })),
    stream: true,
    ...(temperature != null ? { options: { temperature } } : {}),
    ...(maxTokens != null ? { options: { ...(temperature != null ? { temperature } : {}), num_predict: maxTokens } } : {}),
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
