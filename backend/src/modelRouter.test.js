// Auto picks: lanes follow the catalog groups, so a models.json update changes them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { route, classifyLane } from './modelRouter.js';
import { getModels } from './modelCatalog.js';

const GB = 1e9;

/** A small catalog in models.json order, so these tests do not move with the shipped one. */
const CATALOG = [
  { id: 'mcq-raw-8b', group: 'MCQ', uncensored: true },
  { id: 'lfm3:1.7b', group: 'Small & Fast' },
  { id: 'qwen3.5:9b', group: 'Small & Fast' },
  { id: 'qwen3.8:27b', group: 'Powerful' },
  { id: 'rnj-1:8b', group: 'Coding' },
  { id: 'devstral-small-2:24b', group: 'Coding' },
  { id: 'gpt-oss:20b', group: 'Reasoning' },
  { id: 'glm-ocr', group: 'Vision' },
  { id: 'dolphin3', group: 'Uncensored', uncensored: true },
  { id: 'dolphin-mixtral', ollamaId: 'dolphin-mixtral:8x7b', group: 'Uncensored', uncensored: true }
];

const pick = (args) => route({ catalog: CATALOG, ramGb: 64, ...args });

test('the classifier sends code, reasoning and chat to their lanes', () => {
  assert.equal(classifyLane('fix this python function'), 'coding');
  assert.equal(classifyLane('```js\nx()\n```'), 'coding');
  assert.equal(classifyLane('prove it step by step'), 'reasoning');
  assert.equal(classifyLane('hello there'), 'general');
});

test('each lane takes its catalog group', () => {
  const installed = ['lfm3:1.7b', 'qwen3.8:27b', 'rnj-1:8b', 'gpt-oss:20b', 'dolphin3:latest'].map((id) => ({ id }));
  assert.equal(pick({ lane: 'coding', availableModels: installed }).model, 'rnj-1:8b');
  assert.equal(pick({ lane: 'reasoning', availableModels: installed }).model, 'gpt-oss:20b');
  assert.equal(pick({ lane: 'experimental', availableModels: installed }).model, 'dolphin3:latest');
  assert.equal(pick({ uncensored: true, prompt: 'write sql', availableModels: installed }).model, 'dolphin3:latest');
  // General: Small & Fast before Powerful.
  assert.equal(pick({ lane: 'general', availableModels: installed }).model, 'lfm3:1.7b');
  assert.equal(pick({ lane: 'general', availableModels: installed.filter((m) => m.id !== 'lfm3:1.7b') }).model, 'qwen3.8:27b');
});

test('within a group the catalog order wins over the installed order', () => {
  const installed = [{ id: 'devstral-small-2:24b' }, { id: 'rnj-1:8b' }];
  const decision = pick({ lane: 'coding', availableModels: installed });
  assert.equal(decision.model, 'rnj-1:8b');
  assert.equal(decision.reason, 'Coding group for coding');
});

test('a group given by the caller counts, in the caller order', () => {
  const decision = route({
    catalog: [],
    lane: 'coding',
    availableModels: [{ id: 'mine-a:7b', group: 'Coding' }, { id: 'mine-b:7b', group: 'Coding' }]
  });
  assert.equal(decision.model, 'mine-a:7b');
});

test('reasoning falls back to any model that can think', () => {
  const decision = pick({
    lane: 'reasoning',
    availableModels: [
      { id: 'qwen3.5:9b', capabilities: ['completion', 'vision', 'tools', 'thinking'] },
      { id: 'lfm3:1.7b', capabilities: ['completion', 'tools'] }
    ]
  });
  assert.equal(decision.model, 'qwen3.5:9b');
  assert.equal(decision.reason, 'thinking capability for reasoning');
});

test('the uncensored lane prefers the Uncensored group, then flagged models', () => {
  // Same order as the uncensored pick in the chat route.
  assert.equal(pick({ uncensored: true, availableModels: [{ id: 'mcq-raw-8b:latest' }, { id: 'dolphin3:latest' }] }).model, 'dolphin3:latest');
  assert.equal(pick({ uncensored: true, availableModels: [{ id: 'mcq-raw-8b:latest' }, { id: 'qwen3.5:9b' }] }).model, 'mcq-raw-8b:latest');
});

test('other lanes leave uncensored models alone while anything else is installed', () => {
  const installed = [
    { id: 'dolphin3:latest', sizeBytes: 5 * GB },
    { id: 'huihui_ai/qwen3.5-abliterated:9b', sizeBytes: 6 * GB },
    { id: 'llava:13b', sizeBytes: 8 * GB }
  ];
  assert.equal(pick({ lane: 'general', availableModels: installed }).model, 'llava:13b');
  // With nothing else installed, an uncensored model still answers.
  assert.equal(pick({ lane: 'general', availableModels: installed.slice(0, 1) }).model, 'dolphin3:latest');
});

test('embedding models are never picked', () => {
  const decision = pick({
    lane: 'general',
    availableModels: [
      { id: 'nomic-embed-text:latest', sizeBytes: 0.3 * GB },
      { id: 'embeddinggemma-2:270m', sizeBytes: 0.3 * GB, capabilities: ['embedding'] },
      { id: 'notes-encoder:1b', sizeBytes: 9 * GB, capabilities: ['embedding'] },
      { id: 'tiny-chat:1b', sizeBytes: 1 * GB, capabilities: ['completion'] }
    ]
  });
  assert.equal(decision.model, 'tiny-chat:1b');
  assert.equal(pick({ availableModels: [{ id: 'nomic-embed-text:latest' }] }).model, null);
});

test('another tag of a catalog model takes its group, just after the row itself', () => {
  const installed = [{ id: 'devstral-small-2:latest' }, { id: 'qwen3.8:27b-mlx' }];
  assert.deepEqual(pick({ lane: 'coding', availableModels: installed }), {
    model: 'devstral-small-2:latest', lane: 'coding', reason: 'Coding group for coding'
  });
  assert.deepEqual(pick({ lane: 'general', availableModels: installed }), {
    model: 'qwen3.8:27b-mlx', lane: 'general', reason: 'Powerful group for general'
  });
  // The exact tag still comes first, whatever the installed order.
  assert.equal(pick({ lane: 'general', availableModels: [{ id: 'qwen3.8:27b-mlx' }, { id: 'qwen3.8:27b' }] }).model, 'qwen3.8:27b');
  // Another tag of an Uncensored row is uncensored too.
  const mixed = [{ id: 'dolphin-mixtral:latest' }, { id: 'qwen3.5:9b' }];
  assert.equal(pick({ lane: 'general', availableModels: mixed }).model, 'qwen3.5:9b');
  assert.equal(pick({ uncensored: true, availableModels: mixed }).reason, 'Uncensored group for experimental');
});

test('models the catalog does not know route by what their name says', () => {
  const installed = [{ id: 'llava:13b' }, { id: 'qwen2.5-coder:7b' }, { id: 'phi4-reasoning:14b' }, { id: 'huihui_ai/qwen3-abliterated:8b' }];
  assert.deepEqual(pick({ lane: 'coding', availableModels: installed }), {
    model: 'qwen2.5-coder:7b', lane: 'coding', reason: '"code" in the name for coding'
  });
  assert.equal(pick({ lane: 'reasoning', availableModels: installed }).model, 'phi4-reasoning:14b');
  assert.deepEqual(pick({ uncensored: true, availableModels: installed }), {
    model: 'huihui_ai/qwen3-abliterated:8b', lane: 'experimental', reason: 'uncensored flag for experimental'
  });
});

test('a catalog model in another group stays out of the lane', () => {
  // glm-ocr is a Vision pick, so it is not the reasoning model.
  const decision = pick({ lane: 'reasoning', availableModels: [{ id: 'glm-ocr:latest', sizeBytes: 2.7 * GB }, { id: 'qwen3.5:9b', sizeBytes: 6.6 * GB }] });
  assert.equal(decision.model, 'qwen3.5:9b');
  assert.match(decision.reason, /fell back to Small & Fast group/);
});

test('plain installed names get their catalog group by tag', () => {
  // A bare catalog id is name:latest; a row id such as dolphin-mixtral means its own tag.
  assert.equal(pick({ uncensored: true, availableModels: [{ id: 'qwen3.5:9b' }, { id: 'dolphin3:latest' }] }).reason, 'Uncensored group for experimental');
  assert.equal(pick({ uncensored: true, availableModels: [{ id: 'dolphin-mixtral:8x7b' }] }).reason, 'Uncensored group for experimental');
  assert.equal(pick({ lane: 'general', availableModels: [{ id: 'qwen3.8:27b-mlx' }] }).reason, 'Powerful group for general');
});

test('only models that fit memory are considered while one does', () => {
  const installed = [{ id: 'qwen3.8:27b', sizeBytes: 18 * GB }, { id: 'qwen3.5:9b', sizeBytes: 6.6 * GB }];
  assert.equal(route({ catalog: CATALOG, ramGb: 16, lane: 'general', availableModels: installed }).model, 'qwen3.5:9b');
  // Nothing fits: still answer rather than refuse.
  assert.equal(route({ catalog: CATALOG, ramGb: 8, lane: 'general', availableModels: [installed[0]] }).model, 'qwen3.8:27b');
});

test('the largest fitting model is the last resort', () => {
  const decision = pick({ lane: 'coding', availableModels: [{ id: 'aaa:1b', sizeBytes: 1 * GB }, { id: 'bbb:7b', sizeBytes: 7 * GB }] });
  assert.deepEqual(decision, { model: 'bbb:7b', lane: 'coding', reason: 'fell back to the largest fitting model' });
  assert.deepEqual(route({ catalog: CATALOG, availableModels: [] }), { model: null, lane: 'general', reason: 'no models installed' });
});

test('the shipped catalog drives the picks with no code change', () => {
  // Whatever models.json lists first in a group is what Auto takes.
  const shipped = getModels();
  const firstOf = (group) => shipped.find((m) => m.group === group);
  for (const [lane, group] of [['coding', 'Coding'], ['reasoning', 'Reasoning'], ['experimental', 'Uncensored'], ['general', 'Small & Fast']]) {
    const installed = shipped.filter((m) => !m.local).map((m) => ({ id: m.ollamaId || m.id }));
    const decision = route({ lane: /** @type {any} */ (lane), availableModels: installed, ramGb: 512 });
    const row = firstOf(group);
    assert.equal(decision.model, row?.ollamaId || row?.id, `${lane} should take the first ${group} row`);
  }
});

test('this machine today: qwen3:8b and dolphin3 installed', () => {
  // Plain /api/tags names, as the chat route passes them.
  const installed = [
    { id: 'qwen3:8b', sizeBytes: 5225388164 },
    { id: 'dolphin3:latest', sizeBytes: 4920757726 }
  ];
  assert.equal(route({ uncensored: true, availableModels: installed, ramGb: 16 }).model, 'dolphin3:latest');
  assert.equal(route({ prompt: 'hello', availableModels: installed, ramGb: 16 }).model, 'qwen3:8b');
  assert.equal(route({ prompt: 'fix this python bug', availableModels: installed, ramGb: 16 }).model, 'qwen3:8b');
});
