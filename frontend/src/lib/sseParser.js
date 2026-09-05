// @ts-check
// frontend/src/lib/sseParser.js
// An incremental Server-Sent Events parser.
//
// Extracted from ChatApp, where it was written inline and made three assumptions
// the spec does not allow:
//
//   1. that a field is always "data: " with exactly one space (the space is
//      optional, and "data:x" is valid),
//   2. that lines end with \n (a server may send \r\n, and the \r then became
//      part of the parsed JSON, breaking it),
//   3. that an event carries exactly one data line (data lines accumulate, and
//      are joined with newlines, which is how any multi-line payload arrives).
//
// It is separate from the component so it can be tested against those cases
// directly, which is the point: every recent bug in this feature lived in glue
// like this, and none of it had a single test.

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
