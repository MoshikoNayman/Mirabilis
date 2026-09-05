import { describe, test, expect } from 'vitest';
import { createSseParser, parseSseBody } from './sseParser.js';

describe('SSE parsing', () => {
  test('parses a simple event', () => {
    const events = parseSseBody('event: token\ndata: {"token":"hi"}\n\n');
    expect(events).toEqual([{ event: 'token', data: '{"token":"hi"}' }]);
  });

  test('defaults to the message event when none is given', () => {
    expect(parseSseBody('data: plain\n\n')).toEqual([{ event: 'message', data: 'plain' }]);
  });

  // ── the three assumptions the inline version got wrong ───────────────────

  test('handles CRLF line endings', () => {
    // The \r used to survive into the payload and break JSON.parse.
    const events = parseSseBody('event: token\r\ndata: {"token":"hi"}\r\n\r\n');
    expect(events).toEqual([{ event: 'token', data: '{"token":"hi"}' }]);
    expect(JSON.parse(events[0].data)).toEqual({ token: 'hi' });
  });

  test('joins multiple data lines into one payload', () => {
    // Per spec, data lines accumulate. Taking only the first silently truncated
    // any multi-line payload.
    const events = parseSseBody('event: e\ndata: line one\ndata: line two\n\n');
    expect(events[0].data).toBe('line one\nline two');
  });

  test('accepts a field with no space after the colon', () => {
    expect(parseSseBody('event:token\ndata:{"a":1}\n\n')).toEqual([
      { event: 'token', data: '{"a":1}' }
    ]);
  });

  test('strips exactly one leading space, preserving the rest', () => {
    expect(parseSseBody('data:  two spaces\n\n')[0].data).toBe(' two spaces');
  });

  // ── streaming behaviour ──────────────────────────────────────────────────

  test('an event split across chunks is still parsed once', () => {
    const p = createSseParser();
    expect(p.push('event: tok')).toEqual([]);
    expect(p.push('en\ndata: {"tok')).toEqual([]);
    expect(p.push('en":"hi"}\n\n')).toEqual([{ event: 'token', data: '{"token":"hi"}' }]);
  });

  test('a chunk carrying several events yields all of them, in order', () => {
    const p = createSseParser();
    const events = p.push('event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3\n\n');
    expect(events.map((e) => e.event)).toEqual(['a', 'b', 'c']);
  });

  test('one byte at a time produces exactly the same events', () => {
    // The worst case a real socket can deliver.
    const body = 'event: token\ndata: {"token":"x"}\n\nevent: done\ndata: {"ok":true}\n\n';
    const p = createSseParser();
    const out = [];
    for (const ch of body) out.push(...p.push(ch));
    out.push(...p.flush());
    expect(out).toEqual([
      { event: 'token', data: '{"token":"x"}' },
      { event: 'done', data: '{"ok":true}' }
    ]);
  });

  test('a trailing event with no blank line is emitted on flush', () => {
    const p = createSseParser();
    expect(p.push('event: done\ndata: {"ok":true}')).toEqual([]);
    expect(p.flush()).toEqual([{ event: 'done', data: '{"ok":true}' }]);
  });

  test('flush on an empty or whitespace buffer emits nothing', () => {
    const p = createSseParser();
    expect(p.flush()).toEqual([]);
    p.push('\n\n  \n');
    expect(p.flush()).toEqual([]);
  });

  // ── things that must not become events ───────────────────────────────────

  test('comment and keep-alive lines are ignored', () => {
    const events = parseSseBody(': keep-alive\n\nevent: real\ndata: 1\n\n');
    expect(events).toEqual([{ event: 'real', data: '1' }]);
  });

  test('an event with no data line is not emitted', () => {
    // Otherwise a bare "event: ping" would be dispatched as an empty payload.
    expect(parseSseBody('event: ping\n\n')).toEqual([]);
  });

  test('unknown fields are ignored but do not discard the event', () => {
    const events = parseSseBody('event: e\nretry: 5000\nfoo: bar\ndata: 1\n\n');
    expect(events).toEqual([{ event: 'e', data: '1' }]);
  });

  test('an id field is carried through when present', () => {
    expect(parseSseBody('id: 7\nevent: e\ndata: 1\n\n')).toEqual([
      { event: 'e', data: '1', id: '7' }
    ]);
  });

  // ── robustness ───────────────────────────────────────────────────────────

  test('a data payload containing blank lines and braces survives intact', () => {
    const json = JSON.stringify({ text: 'para one\n\npara two', nested: { a: [1, 2] } });
    const events = parseSseBody(`event: token\ndata: ${json}\n\n`);
    expect(JSON.parse(events[0].data)).toEqual({ text: 'para one\n\npara two', nested: { a: [1, 2] } });
  });

  test('junk input never throws', () => {
    for (const junk of ['', '\n', '\r\n', 'garbage', ':::', 'data', null, undefined]) {
      expect(() => parseSseBody(/** @type {any} */ (junk))).not.toThrow();
    }
  });
});
