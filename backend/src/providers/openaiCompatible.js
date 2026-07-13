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

export async function streamOpenAICompatibleChat({ baseUrl, apiKey, model, messages, signal, onToken, temperature, maxTokens, providerLabel = 'OpenAI-compatible' }) {
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
