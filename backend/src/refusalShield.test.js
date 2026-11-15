// The refusal shield with fake attempts: an answer streams through, a refusal is
// dropped and the next attempt runs, the prefill shows first, the last attempt is
// shown even when it refuses, a failed retry is passed over, and an abort stops it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { streamShielded } from './refusalShield.js';
import { PREFILL } from './refusal.js';

const REFUSAL = "I'm sorry, but I can't help with that.";
const ANSWER = 'Here is a savage roast for your always-late friend. ';

/** Streams `text` token by token into onToken; stops when the signal aborts. */
const scripted = (text) => async (_attempt, { signal, onToken }) => {
  for (const piece of String(text).match(/.{1,8}/gs) || []) {
    if (signal.aborted) return;
    onToken(piece);
  }
};

/** Collects what the shield shows and the retry events it fires. */
function harness() {
  let shown = '';
  const retries = [];
  return {
    onToken: (t) => { shown += t; },
    onRetry: (r) => retries.push(r),
    get shown() { return shown; },
    retries
  };
}

test('an answer streams straight through, no retry', async () => {
  const h = harness();
  const out = await streamShielded({
    plan: [{ model: 'dolphin3', prefill: false }, { model: 'dolphin3', prefill: true }],
    run: scripted(ANSWER), onToken: h.onToken, onRetry: h.onRetry
  });
  assert.equal(h.shown, ANSWER);
  assert.equal(out.text, ANSWER);
  assert.equal(out.model, 'dolphin3');
  assert.equal(out.retries, 0);
  assert.deepEqual(h.retries, []);
});

test('a refusal is dropped and the same model is asked again with the prefill', async () => {
  const h = harness();
  const replies = [REFUSAL, `${ANSWER}Enjoy.`];
  let n = 0;
  const out = await streamShielded({
    plan: [{ model: 'dolphin3', prefill: false }, { model: 'dolphin3', prefill: true }],
    onToken: h.onToken, onRetry: h.onRetry,
    run: async (attempt, stream) => {
      // The second attempt carries the prefill flag.
      assert.equal(attempt.prefill, n === 1);
      return scripted(replies[n++])(attempt, stream);
    }
  });
  assert.equal(n, 2, 'asked twice');
  assert.equal(h.shown, `${PREFILL}${ANSWER}Enjoy.`, 'the prefill shows before the continuation');
  assert.ok(!h.shown.includes("I'm sorry"), 'nothing of the refusal is shown');
  assert.equal(out.retries, 1);
  assert.deepEqual(h.retries, [{ attempt: 2, model: 'dolphin3' }]);
});

test('a second model answers when the first keeps refusing', async () => {
  const h = harness();
  const byModel = { dolphin3: REFUSAL, 'huihui:8b': `${ANSWER}There.` };
  const out = await streamShielded({
    plan: [
      { model: 'dolphin3', prefill: false },
      { model: 'dolphin3', prefill: true },
      { model: 'huihui:8b', prefill: true }
    ],
    onToken: h.onToken, onRetry: h.onRetry,
    run: (attempt, stream) => scripted(byModel[attempt.model])(attempt, stream)
  });
  assert.equal(h.shown, `${PREFILL}${ANSWER}There.`);
  assert.equal(out.model, 'huihui:8b');
  assert.equal(out.retries, 2);
  assert.deepEqual(h.retries, [{ attempt: 2, model: 'dolphin3' }, { attempt: 3, model: 'huihui:8b' }]);
});

test('every attempt refuses: the last one is shown as is', async () => {
  const h = harness();
  const out = await streamShielded({
    plan: [
      { model: 'dolphin3', prefill: false },
      { model: 'dolphin3', prefill: true },
      { model: 'huihui:8b', prefill: true }
    ],
    onToken: h.onToken, onRetry: h.onRetry,
    run: scripted(REFUSAL)
  });
  assert.equal(h.shown, `${PREFILL}${REFUSAL}`, 'the last attempt had the prefill');
  assert.equal(out.model, 'huihui:8b');
  assert.equal(out.retries, 2);
});

test('a retry that fails before showing anything is passed over', async () => {
  const h = harness();
  let n = 0;
  const out = await streamShielded({
    plan: [
      { model: 'dolphin3', prefill: false },
      { model: 'dolphin3', prefill: true },
      { model: 'huihui:8b', prefill: true }
    ],
    onToken: h.onToken, onRetry: h.onRetry,
    run: async (attempt, stream) => {
      n += 1;
      if (attempt.model === 'dolphin3') {
        if (n === 2) throw new Error('loader crashed');
        return scripted(REFUSAL)(attempt, stream);
      }
      return scripted(`${ANSWER}Done.`)(attempt, stream);
    }
  });
  assert.equal(h.shown, `${PREFILL}${ANSWER}Done.`, 'the model that answered is shown');
  assert.equal(out.model, 'huihui:8b');
});

test('the first attempt failing throws, as it would without the shield', async () => {
  const h = harness();
  await assert.rejects(
    streamShielded({
      plan: [{ model: 'dolphin3', prefill: false }, { model: 'dolphin3', prefill: true }],
      onToken: h.onToken, onRetry: h.onRetry,
      run: async () => { throw new Error('engine not running'); }
    }),
    /engine not running/
  );
  assert.equal(h.shown, '');
});

test('an abort stops the shield and returns what was shown', async () => {
  const h = harness();
  const ctrl = new AbortController();
  const out = await streamShielded({
    plan: [{ model: 'dolphin3', prefill: false }, { model: 'dolphin3', prefill: true }],
    signal: ctrl.signal, onToken: h.onToken, onRetry: h.onRetry,
    run: async (_attempt, { signal, onToken }) => {
      onToken(ANSWER); // an answer, so it starts streaming live
      ctrl.abort();
      await new Promise((r) => setTimeout(r, 1));
      if (!signal.aborted) onToken('late');
    }
  });
  assert.equal(h.shown, ANSWER);
  assert.equal(out.text, ANSWER);
  assert.deepEqual(h.retries, [], 'no retry after an abort');
});

test('a mid-answer failure propagates once the answer has started', async () => {
  const h = harness();
  await assert.rejects(
    streamShielded({
      plan: [{ model: 'dolphin3', prefill: false }, { model: 'dolphin3', prefill: true }],
      onToken: h.onToken, onRetry: h.onRetry,
      run: async (_attempt, { onToken }) => {
        onToken(ANSWER);
        throw new Error('stream cut');
      }
    }),
    /stream cut/
  );
  assert.equal(h.shown, ANSWER, 'the answer so far stays shown');
});
