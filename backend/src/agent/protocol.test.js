import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentAction, protocolInstructions } from './protocol.js';

test('a clean tool action parses', () => {
  const a = parseAgentAction('{"thought":"look first","action":"tool","tool":"read_file","args":{"path":"a.txt"}}');
  assert.equal(a.kind, 'tool');
  assert.equal(a.tool, 'read_file');
  assert.deepEqual(a.args, { path: 'a.txt' });
  assert.equal(a.thought, 'look first');
});

test('a clean finish action parses', () => {
  const a = parseAgentAction('{"action":"finish","summary":"All done."}');
  assert.equal(a.kind, 'finish');
  assert.equal(a.summary, 'All done.');
});

// ── the ways real models actually reply ────────────────────────────────────

test('a fenced json block parses', () => {
  const a = parseAgentAction('Sure, here is my next step:\n```json\n{"action":"tool","tool":"list_dir","args":{"path":"."}}\n```\n');
  assert.equal(a.kind, 'tool');
  assert.equal(a.tool, 'list_dir');
});

test('prose wrapped around the object parses', () => {
  const a = parseAgentAction('I will read the file. {"action":"tool","tool":"read_file","args":{"path":"x"}} Let me know!');
  assert.equal(a.kind, 'tool');
});

test('a trailing comma is repaired rather than failing the iteration', () => {
  const a = parseAgentAction('{"action":"tool","tool":"list_dir","args":{"path":".",},}');
  assert.equal(a.kind, 'tool');
  assert.equal(a.tool, 'list_dir');
});

test('smart quotes are repaired', () => {
  const a = parseAgentAction('{\u201Caction\u201D:\u201Cfinish\u201D,\u201Csummary\u201D:\u201Cdone\u201D}');
  assert.equal(a.kind, 'finish');
  assert.equal(a.summary, 'done');
});

test('nested braces and braces inside strings do not confuse extraction', () => {
  const a = parseAgentAction('{"action":"tool","tool":"write_file","args":{"path":"f.json","content":"{\\"nested\\": {\\"deep\\": 1}}"}}');
  assert.equal(a.kind, 'tool');
  assert.match(a.args.content, /nested/);
});

test('the shorthand form without an explicit action is accepted', () => {
  const a = parseAgentAction('{"tool":"search_files","args":{"pattern":"x"}}');
  assert.equal(a.kind, 'tool');
  assert.equal(a.tool, 'search_files');
});

test('common synonyms for finishing are accepted', () => {
  for (const word of ['finish', 'done', 'complete']) {
    assert.equal(parseAgentAction(`{"action":"${word}","summary":"s"}`).kind, 'finish');
  }
});

test('alternate argument keys are accepted', () => {
  assert.deepEqual(parseAgentAction('{"action":"tool","tool":"t","arguments":{"a":1}}').args, { a: 1 });
  assert.deepEqual(parseAgentAction('{"action":"tool","tool":"t","parameters":{"b":2}}').args, { b: 2 });
});

// ── genuine failures are reported, not guessed at ──────────────────────────

test('a reply with no JSON is invalid, with a usable message', () => {
  const a = parseAgentAction('I think we should probably read the config file first.');
  assert.equal(a.kind, 'invalid');
  assert.match(a.error, /No JSON object/);
});

test('a tool action with no tool name is invalid', () => {
  const a = parseAgentAction('{"action":"tool","args":{}}');
  assert.equal(a.kind, 'invalid');
  assert.match(a.error, /no tool name/);
});

test('an unrecognised action is read as a tool name, so the registry can correct it', () => {
  // Real models put the tool name in the action field: {"action":"read_file"}.
  // Treating that as a tool call means the registry answers with "Unknown tool
  // X. Available: ..." which tells the model exactly what it may use. The older
  // behaviour returned "Unrecognised action" and taught it nothing.
  const a = parseAgentAction('{"action":"ponder"}');
  assert.equal(a.kind, 'tool');
  assert.equal(a.tool, 'ponder');
});

test('an action that cannot be a tool name is still invalid', () => {
  // Anything not shaped like an identifier is a genuine formatting failure.
  const a = parseAgentAction('{"action":"think very hard about it"}');
  assert.equal(a.kind, 'invalid');
  assert.match(a.error, /tool.*finish|finish.*tool/);
});

test('unparseable input never throws', () => {
  for (const junk of ['', null, undefined, '{{{{', '{"a":', 12345, {}]) {
    const a = parseAgentAction(/** @type {any} */ (junk));
    assert.ok(['invalid', 'tool', 'finish'].includes(a.kind));
  }
});

test('a malformed args value degrades to an empty object rather than crashing', () => {
  const a = parseAgentAction('{"action":"tool","tool":"t","args":"not-an-object"}');
  assert.equal(a.kind, 'tool');
  assert.deepEqual(a.args, {});
});

test('the instructions state the contract and list only the given tools', () => {
  const text = protocolInstructions('  - read_file: reads');
  assert.match(text, /EXACTLY ONE JSON object/);
  assert.match(text, /read_file/);
  assert.match(text, /"action": "finish"/);
});
