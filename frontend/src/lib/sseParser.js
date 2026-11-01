// @ts-check
// Incremental Server-Sent Events parser. Handles an optional space after the
// colon, CRLF line endings and multi-line data, per the spec.

/**
 * Create a parser that turns arbitrary chunks into whole events.
 * Feed it decoded text; it returns the events completed by that chunk.
 *
 * @returns {{ push: (chunk: string) => Array<{event: string, data: string, id?: string}>, flush: () => Array<{event: string, data: string, id?: string}> }}
 */
export function createSseParser() {
  let buffer = '';

  /** Turn one raw event block into a dispatchable event. */
  const parseBlock = (block) => {
    let event = 'message';
    let id;
    /** @type {string[]} */
    const dataLines = [];

    for (const rawLine of block.split('\n')) {
      // A line may still carry a trailing \r when the stream used CRLF.
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      // A line starting with a colon is a comment, used as a keep-alive.
      if (line.startsWith(':')) continue;

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      // Exactly one leading space after the colon is stripped, per the spec.
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
      else if (field === 'id') id = value;
      // `retry` and unknown fields are ignored.
    }

    if (dataLines.length === 0) return null;
    // Multiple data lines belong to one event and are joined with newlines.
    return id === undefined
      ? { event, data: dataLines.join('\n') }
      : { event, data: dataLines.join('\n'), id };
  };

  const drain = (text, requireTerminator) => {
    const out = [];
    // Events are separated by a blank line, in either line ending.
    const parts = text.split(/\r?\n\r?\n/);
    // The final part is only complete if the caller says the stream ended.
    const complete = requireTerminator ? parts : parts.slice(0, -1);
    buffer = requireTerminator ? '' : parts[parts.length - 1];
    for (const block of complete) {
      if (!block.trim()) continue;
      const parsed = parseBlock(block);
      if (parsed) out.push(parsed);
    }
    return out;
  };

  return {
    /** Feed a chunk. Returns whatever events it completed. */
    push(chunk) {
      buffer += String(chunk ?? '');
      return drain(buffer, false);
    },
    /** Call when the stream ends, to emit a trailing event with no blank line. */
    flush() {
      if (!buffer.trim()) { buffer = ''; return []; }
      return drain(buffer, true);
    }
  };
}

/** Convenience: parse a whole SSE body at once. */
export function parseSseBody(text) {
  const p = createSseParser();
  return [...p.push(String(text ?? '')), ...p.flush()];
}
