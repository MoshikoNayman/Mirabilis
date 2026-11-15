import test from 'node:test';
import assert from 'node:assert/strict';

import { isRefusal, refusalVerdict, prefillMessage, PREFILL, HOLD_CHARS } from './refusal.js';

const REFUSALS = [
  "I'm sorry, but I can't help with that.",
  'I\u2019m sorry, but I can\u2019t assist with that request.',
  'Sorry, I cannot provide that information.',
  'I cannot and will not provide instructions for that.',
  "I can't fulfill this request.",
  "I won't write that.",
  "I won't be able to help with this one.",
  "I'm unable to help with this.",
  'I am not able to create that content.',
  'I must decline this request.',
  "I don't feel comfortable writing that.",
  'As an AI language model, I cannot generate that.',
  "Unfortunately, I can't do that.",
  'I apologize, but I cannot assist with that.',
  "That goes against my guidelines, so I'll pass.",
  "Sure, here's why I can't help with that: it could hurt someone.",
  "That is a sensitive topic. I can't help with it.",
  "<think>\nThe user wants a story.\n</think>\n\nI'm sorry, but I can't help with that.",
  "**I can't help with that.**",
  "> I can't assist with that."
];

const ANSWERS = [
  "I can't wait to help you plan this trip! Here's an itinerary.",
  "I'm sorry to hear that. Here are some tips to feel better.",
  "I won't lie, this one is tricky. First, open the terminal.",
  "I can't help but notice you asked about pasta. Here's a recipe.",
  "Sure! Here's a short poem about the sea.",
  'As an AI, I can explain how vaccines work. Vaccines train the immune system.',
  'Unfortunately, the API does not support streaming yet, so use polling.',
  "I can't give exact numbers, but here's a solid estimate: about 40 percent.",
  'The site terms violate the GDPR in two places.',
  "Here is the code:\n```js\nconsole.log('I cannot fail');\n```",
  'I cannot stress enough how much sleep matters.',
  ''
];

test('opening refusals are recognised, typographic apostrophes and markdown included', () => {
  for (const text of REFUSALS) assert.equal(isRefusal(text), true, text);
});

test('answers that only sound like refusals are not', () => {
  for (const text of ANSWERS) assert.equal(isRefusal(text), false, text);
});

test('a refusal later in a long answer is not read', () => {
  const long = `${'Here is a long and helpful answer with plenty of detail. '.repeat(8)}I can't help with that part.`;
  assert.equal(isRefusal(long), false);
});

test('the verdict waits for a sentence, an open think block, or the hold limit', () => {
  assert.equal(refusalVerdict("I'm"), 'pending');
  assert.equal(refusalVerdict('Sure!'), 'pending', 'a short first sentence does not settle it');
  assert.equal(refusalVerdict('<think>\nthe user wants'), 'pending');
  assert.equal(refusalVerdict("I'm sorry, but I can't help with that."), 'refusal');
  assert.equal(refusalVerdict('Sure! Here is a short poem about the sea. Waves'), 'answer');
  assert.equal(refusalVerdict('x'.repeat(HOLD_CHARS)), 'answer', 'no sentence end still settles at the limit');
});

test('the end of the stream settles a short reply', () => {
  assert.equal(refusalVerdict('Ok', { final: true }), 'answer');
  assert.equal(refusalVerdict("I can't.", { final: true }), 'answer', 'no verb: not a recognisable refusal');
  assert.equal(refusalVerdict("I can't do that.", { final: true }), 'refusal');
  assert.equal(refusalVerdict('<think>\nstill thinking', { final: true }), 'answer');
});

test('the prefill gives a thinking model an empty think block first', () => {
  assert.deepEqual(prefillMessage(false), { role: 'assistant', content: PREFILL });
  assert.deepEqual(prefillMessage(true), { role: 'assistant', content: `<think>\n\n</think>\n\n${PREFILL}` });
});
