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
    // A stalled host must not hang the model picker.
    const res = await fetch(`${base}/v1/models`, {
      headers: buildAnthropicHeaders(apiKey),
      signal: AbortSignal.timeout(8000)
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

/**
 * Claude 5 and later answer 400 to temperature, top_p or top_k and to a
 * trailing assistant prefill. Matched on the major version (claude-haiku-5-5,
 * claude-opus-6; not claude-sonnet-4-5 or claude-3-5-sonnet), so later models
 * need no change.
 * @param {string} [model]
 * @returns {boolean}
 */
export function isClaude5OrLater(model) {
  const m = /claude-(?:[a-z]+-)?(\d{1,2})(?!\d)/i.exec(String(model || ''));
  return Boolean(m) && Number(m?.[1]) >= 5;
}

/**
 * The turns without any trailing assistant prefill.
 * @template {{ role: string }} T
 * @param {T[]} turns
 * @returns {T[]}
 */
export function withoutTrailingAssistant(turns) {
  let end = turns.length;
  while (end > 0 && turns[end - 1].role === 'assistant') end -= 1;
  return end === turns.length ? turns : turns.slice(0, end);
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
      // Turns with images become content blocks (base64 images + text).
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
  // Anthropic requires a leading user turn; the history window can start on an assistant turn.
  while (conversation.length && conversation[0].role !== 'user') conversation.shift();

  const fixedSampling = isClaude5OrLater(model);
  // Anthropic only accepts temperature in [0, 1]; the UI slider goes to 2.
  const clampedTemp = temperature != null && !fixedSampling ? Math.min(1, Math.max(0, temperature)) : null;

  const payload = {
    model,
    messages: fixedSampling ? withoutTrailingAssistant(conversation) : conversation,
    // Required by Anthropic. High default to match the uncapped providers.
    max_tokens: maxTokens != null ? maxTokens : 8192,
    // Streaming keeps the UI live and time-to-first-token accurate.
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

        // Mid-stream failures arrive as an `error` event on a 200 response.
        if (frame.type === 'error') {
          const detail = frame.error?.message || 'stream error';
          throw new Error(`${providerLabel} API error: ${detail}`);
        }
        if (frame.type === 'content_block_delta' && typeof frame.delta?.text === 'string') {
          if (frame.delta.text) { onToken(frame.delta.text); emitted = true; }
        }
        // Exact token counts for the receipt.
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
    // Aborts are user-initiated; everything else propagates so the route rolls back.
    if (error.name === 'AbortError') return;
    throw error;
  }
}