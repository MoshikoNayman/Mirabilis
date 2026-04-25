import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

import { createIntelLedgerStorage } from './storage/intelLedger.js';

test('eval orchestration stores and retrieves run scorecards', async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), 'mirabilis-eval-orchestration-'));
  const storePath = join(tempDir, 'intelledger.json');
  const storage = createIntelLedgerStorage(storePath);

  try {
    await storage.ensureStore();
    const session = await storage.createSession('eval-user', 'Eval Session', 'Scoring baseline');
    const interaction = await storage.ingestInteraction(session.id, 'text', 'Need follow up by tomorrow.', 'manual');
    const storedSignals = await storage.storeSignals(session.id, interaction.id, [{
      type: 'ask',
      value: 'Need follow up by tomorrow.',
      quote: 'Need follow up by tomorrow.',
      confidence: 0.9
    }]);

    await storage.addSignalFeedback(session.id, storedSignals[0].id, 'accept', 'Looks good', 'human');
    await storage.replaceActionsForSession(session.id, [{
      title: 'Follow up tomorrow',
      priority: 'high',
      status: 'open',
      source_signal_id: storedSignals[0].id,
      source_signal_type: 'ask'
    }], 'auto_extract');

    const run = await storage.runSessionEvaluation(session.id, {
      windowDays: 30,
      trigger: 'manual',
      note: 'baseline run'
    });

    assert.ok(run);
    assert.equal(run.session_id, session.id);
    assert.equal(typeof run.overall_score, 'number');
    assert.equal(run.window_days, 30);
    assert.equal(run.trigger, 'manual');
    assert.ok(['pass', 'watch', 'fail'].includes(run.status));

    const list = await storage.getEvalRunsBySession(session.id, { limit: 10 });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, run.id);

    const fetched = await storage.getEvalRunById(run.id);
    assert.ok(fetched);
    assert.equal(fetched.id, run.id);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
