import test from 'node:test';
import assert from 'node:assert/strict';

import { selectHistoryWindow } from './historyWindow.js';

// Deterministic and easy to reason about: 1 token per 4 characters.
const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

/** A message costing exactly `tokens` tokens. */
const msg = (id, tokens) => ({ id, content: 'x'.repeat(tokens * 4) });

/** Build a conversation of n messages, each `each` tokens. */
const convo = (n, each = 10) => Array.from({ length: n }, (_, i) => msg(i, each));

const select = (messages, over = {}) => selectHistoryWindow(messages, {
  budgetTokens: 100, minMessages: 2, estimateTokens, ...over
});

test('a short history is returned whole and stays anchored at zero', () => {
  const messages = convo(5, 10); // 50 tokens, well under budget
  const out = select(messages);
  assert.equal(out.startIndex, 0);
  assert.equal(out.messages.length, 5);
  assert.equal(out.tokens, 50);
  assert.equal(out.evicted, false);
});

test('the window never exceeds the token budget once it has evicted', () => {
  const messages = convo(40, 10); // 400 tokens against a 100 budget
  const out = select(messages);
  assert.ok(out.tokens <= 100, `window is ${out.tokens} tokens, over the 100 budget`);
  assert.equal(out.evicted, true);
});

test('the most recent messages are always the ones kept', () => {
  const messages = convo(40, 10);
  const out = select(messages);
  const last = messages[messages.length - 1];
  assert.equal(out.messages[out.messages.length - 1].id, last.id, 'the newest turn must be included');
  // Contiguous slice ending at the newest message.
  assert.deepEqual(
    out.messages.map((m) => m.id),
    messages.slice(out.startIndex).map((m) => m.id)
  );
});

// ── the point of the whole module: prefix stability ──────────────────────────

test('the anchor holds still across turns, so the prompt prefix is reused', () => {
  // Simulate a real conversation: after eviction, keep adding turns and feeding
  // the previous anchor back in. A naive sliding window moves the front on EVERY
  // turn; the anchored one should move only occasionally.
  let messages = convo(12, 10); // 120 tokens, already over the 100 budget
  let startIndex = 0;
  const anchors = [];

  for (let turn = 0; turn < 20; turn += 1) {
    const out = select(messages, { startIndex });
    startIndex = out.startIndex;
    anchors.push(startIndex);
    assert.ok(out.tokens <= 100, `turn ${turn}: window ${out.tokens} exceeds budget`);
    messages = messages.concat([msg(`new-${turn}`, 10)]);
  }

  const moves = anchors.filter((a, i) => i > 0 && a !== anchors[i - 1]).length;
  assert.ok(
    moves <= 8,
    `anchor moved ${moves} times in 20 turns; it should hold still between evictions, ` +
    'otherwise the KV cache prefix is invalidated every turn'
  );
  // And it must never move backwards, which would also break the prefix.
  for (let i = 1; i < anchors.length; i += 1) {
    assert.ok(anchors[i] >= anchors[i - 1], 'the anchor must only ever move forward');
  }
});

test('eviction frees a chunk at once rather than trimming one message', () => {
  // Trimming the minimum would put the window right back at the budget edge and
  // guarantee another eviction on the very next turn.
  const messages = convo(12, 10); // 120 tokens vs a 100 budget
  const out = select(messages, { startIndex: 0 });
  assert.ok(out.evicted, 'should have evicted');
  assert.ok(
    out.tokens <= 80,
    `after eviction the window is ${out.tokens} tokens; it should drop well under ` +
    'the budget so the next few turns fit without evicting again'
  );
});

// ── robustness against a rewritten history ──────────────────────────────────

test('a stale anchor past the end of a truncated history is clamped', () => {
  // Regenerate and branch both rewrite the array. A stale index must never
  // select an empty or wrong slice.
  const messages = convo(3, 10);
  const out = select(messages, { startIndex: 99 });
  assert.ok(out.messages.length > 0, 'must still return the recent messages');
  assert.ok(out.startIndex <= messages.length - 1);
  assert.equal(out.messages[out.messages.length - 1].id, 2);
});

test('a negative or non-integer anchor is treated as zero', () => {
  const messages = convo(4, 10);
  for (const bad of [-5, NaN, undefined, null, 1.5]) {
    const out = select(messages, { startIndex: /** @type {any} */ (bad) });
    assert.equal(out.messages.length, 4, `anchor ${bad} should fall back to the whole history`);
  }
});

test('an empty history yields an empty window', () => {
  const out = select([]);
  assert.deepEqual(out.messages, []);
  assert.equal(out.tokens, 0);
  assert.equal(out.startIndex, 0);
});

// ── the guards that bound the window ────────────────────────────────────────

test('minMessages keeps recent turns even when a single message blows the budget', () => {
  // One enormous message must not evict the conversation down to nothing, or the
  // model loses the question it is meant to answer.
  const messages = [msg('huge', 5000), msg('a', 10), msg('b', 10)];
  const out = select(messages, { minMessages: 2 });
  assert.ok(out.messages.length >= 2, 'must retain the minimum recent turns');
  assert.equal(out.messages[out.messages.length - 1].id, 'b');
});

test('maxMessages caps the count independently of tokens', () => {
  const messages = convo(50, 1); // only 50 tokens total, so tokens are not binding
  const out = select(messages, { maxMessages: 10 });
  assert.equal(out.messages.length, 10);
  assert.equal(out.evicted, true);
});

test('the window is always a contiguous tail of the history', () => {
  // Property check across many shapes: whatever we return must equal the slice
  // from the reported startIndex, or the caller and the anchor disagree.
  for (const n of [1, 5, 20, 60]) {
    for (const each of [1, 10, 60]) {
      const messages = convo(n, each);
      const out = select(messages, { maxMessages: 25 });
      assert.deepEqual(
        out.messages.map((m) => m.id),
        messages.slice(out.startIndex).map((m) => m.id),
        `n=${n} each=${each}: returned window must match its own startIndex`
      );
    }
  }
});
