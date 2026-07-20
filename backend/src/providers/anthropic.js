// @ts-check
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

function buildAnthropicHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION
  };
}

export async function listAnthropicModels({ baseUrl, apiKey }) {
  if (!apiKey) return [];
  const base = String(baseUrl || ANTHROPIC_BASE_URL).replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/v1/models`, {
      headers: buildAnthropicHeaders(apiKey)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map((item) => ({
      id: item.id,
      name: item.id,
      label: item.display_name || item.id
    }));
  } catch (error) {
    console.error('Failed to list Anthropic models:', error.message);
    return [];
  }
}

export async function streamAnthropicChat({ baseUrl, apiKey, model, messages, signal, onToken, temperature, maxTokens, providerLabel = 'Claude' }) {
  const base = String(baseUrl || ANTHROPIC_BASE_URL).replace(/\/$/, '');
  const system = messages
    .filter((message) => message.role === 'system' && message.content)
    .map((message) => String(message.content).trim())
    .filter(Boolean)
    .join('\n\n');

  const conversation = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => {
      // Vision: when a turn carries images, send Anthropic content blocks
      // (base64 image parts + a text part) instead of a bare string.
      const imgs = Array.isArray(message.images) ? message.images : [];
      if (imgs.length) {
        return {
          role: message.role,
          content: [
            ...imgs.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })),
            ...(message.content ? [{ type: 'text', text: String(message.content) }] : [])
          ]
        };
      }
      return { role: message.role, content: String(message.content || '') };
    });
  // Anthropic rejects a conversation that does not start with a user turn; the
  // sliding history window can leave a leading assistant turn, so drop them.
  while (conversation.length && conversation[0].role !== 'user') conversation.shift();

  // Anthropic only accepts temperature in [0, 1]; the UI slider goes to 2.
  const clampedTemp = temperature != null ? Math.min(1, Math.max(0, temperature)) : null;

  const payload = {
    model,
    messages: conversation,
    // Anthropic requires max_tokens. Default high so replies are not silently
    // truncated (Ollama/OpenAI-compatible send no cap); the user override still wins.
    max_tokens: maxTokens != null ? maxTokens : 8192,
    stream: false,
    ...(system ? { system } : {}),
    ...(clampedTemp != null ? { temperature: clampedTemp } : {})
  };

  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: buildAnthropicHeaders(apiKey),
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      let detail = '';
      try {
        const parsed = JSON.parse(bodyText || '{}');
        detail = parsed?.error?.message || parsed?.message || '';
      } catch {
        detail = bodyText || '';
      }
      if (res.status === 429 && !detail) {
        detail = 'Rate limit or quota exceeded for this API key.';
      }
      throw new Error(`${providerLabel} API error: ${res.status}${detail ? ` - ${detail}` : ''}`);
    }

    const data = await res.json();
    const text = (data?.content || [])
      .filter((block) => block?.type === 'text' && typeof block?.text === 'string')
      .map((block) => block.text)
      .join('');

    if (text) {
      onToken(text);
      return;
    }

    throw new Error(`${providerLabel} returned no text content.`);
  } catch (error) {
    // Propagate real failures (aborts are user-initiated) so the stream handler
    // sends an `error` event and rolls back instead of saving the error as reply.
    if (error.name === 'AbortError') return;
    throw error;
  }
}