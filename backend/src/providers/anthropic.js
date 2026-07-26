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

export async function streamAnthropicChat({ baseUrl, apiKey, model, messages, signal, onToken, onStats, temperature, maxTokens, providerLabel = 'Claude' }) {
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
    // Stream properly. With stream:false the whole reply arrived as one blob and
    // was handed to onToken in a single call, so the UI showed nothing at all
    // until the model was completely finished. It also made the performance
    // receipt meaningless: time-to-first-token was recorded at the moment the
    // LAST token arrived, so generation time always computed as roughly zero.
    stream: true,
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

    if (!res.body) throw new Error(`${providerLabel} returned no response body.`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let emitted = false;
    /** @type {{outputTokens: number|null, inputTokens: number|null}} */
    const usage = { outputTokens: null, inputTokens: null };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payloadText = trimmed.slice(5).trim();
        if (!payloadText || payloadText === '[DONE]') continue;
        let frame;
        try {
          frame = JSON.parse(payloadText);
        } catch {
          continue; // partial frame; the next chunk completes it
        }

        // Anthropic reports mid-stream failures as an `error` event on an
        // already-200 response, the same trap the other adapters had.
        if (frame.type === 'error') {
          const detail = frame.error?.message || 'stream error';
          throw new Error(`${providerLabel} API error: ${detail}`);
        }
        if (frame.type === 'content_block_delta' && typeof frame.delta?.text === 'string') {
          if (frame.delta.text) { onToken(frame.delta.text); emitted = true; }
        }
        // Exact counts, so the receipt stops guessing from character length.
        if (frame.type === 'message_start' && frame.message?.usage) {
          usage.inputTokens = frame.message.usage.input_tokens ?? null;
        }
        if (frame.type === 'message_delta' && frame.usage) {
          usage.outputTokens = frame.usage.output_tokens ?? null;
        }
      }
    }

    if (typeof onStats === 'function' && (usage.outputTokens != null || usage.inputTokens != null)) {
      onStats({ evalCount: usage.outputTokens, promptEvalCount: usage.inputTokens });
    }
    if (!emitted) throw new Error(`${providerLabel} returned no text content.`);
  } catch (error) {
    // Propagate real failures (aborts are user-initiated) so the stream handler
    // sends an `error` event and rolls back instead of saving the error as reply.
    if (error.name === 'AbortError') return;
    throw error;
  }
}