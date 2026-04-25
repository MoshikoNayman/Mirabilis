import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

import { createIntelLedgerStorage } from './storage/intelLedger.js';
import { createIntelLedgerRoutes } from './routes/intelLedger.js';

function createApp(storage, storePath) {
  const app = express();
  app.use(express.json());
  app.use('/api/intelledger', createIntelLedgerRoutes(storage, {
    streamWithProvider: async ({ onToken }) => {
      onToken('{"signals":[{"type":"ask","value":"Send update by tomorrow.","owner":"Ops","due_date":"tomorrow","confidence":0.88}]}');
    },
    getEffectiveModel: async () => 'test-model',
    config: {
      intelLedgerStorePath: storePath,
      aiProvider: 'ollama',
      openAIApiKey: '',
      openAIBaseUrl: ''
    }
  }));
  return app;
}

async function withServer(app, callback) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test('eval orchestration endpoints run per-session and batch scorecards', async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), 'mirabilis-eval-orchestration-api-'));
  const storePath = join(tempDir, 'intelledger.json');
  const storage = createIntelLedgerStorage(storePath);
  await storage.ensureStore();
  const app = createApp(storage, storePath);

  try {
    await withServer(app, async (baseUrl) => {
      const createA = await fetch(`${baseUrl}/api/intelledger/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'eval-api-user', title: 'Eval Session A' })
      });
      const createB = await fetch(`${baseUrl}/api/intelledger/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'eval-api-user', title: 'Eval Session B' })
      });
      const sessionA = (await createA.json())?.session;
      const sessionB = (await createB.json())?.session;
      assert.ok(sessionA?.id);
      assert.ok(sessionB?.id);

      const ingestA = await fetch(`${baseUrl}/api/intelledger/sessions/${sessionA.id}/ingest/text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Please send update by tomorrow.' })
      });
      const ingestB = await fetch(`${baseUrl}/api/intelledger/sessions/${sessionB.id}/ingest/text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Confirm rollback plan by tomorrow.' })
      });
      assert.equal(ingestA.status, 200);
      assert.equal(ingestB.status, 200);

      const runA = await fetch(`${baseUrl}/api/intelledger/sessions/${sessionA.id}/evals/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trigger: 'manual', window_days: 30 })
      });
      assert.equal(runA.status, 201);
      const runAPayload = await runA.json();
      assert.ok(runAPayload?.eval_run?.id);
      assert.equal(typeof runAPayload.eval_run.overall_score, 'number');

      const scorecard = await fetch(`${baseUrl}/api/intelledger/sessions/${sessionA.id}/scorecard`);
      assert.equal(scorecard.status, 200);
      const scorePayload = await scorecard.json();
      assert.equal(scorePayload?.scorecard?.id, runAPayload.eval_run.id);

      const batchRun = await fetch(`${baseUrl}/api/intelledger/evals/run-batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'eval-api-user',
          session_ids: [sessionA.id, sessionB.id],
          trigger: 'batch'
        })
      });
      assert.equal(batchRun.status, 200);
      const batchPayload = await batchRun.json();
      assert.equal(batchPayload.executed_count, 2);
      assert.equal(batchPayload.summary.total, 2);
      assert.ok(Array.isArray(batchPayload.runs));

      const runId = batchPayload.runs[0]?.id;
      assert.ok(runId);
      const runLookup = await fetch(`${baseUrl}/api/intelledger/evals/${runId}`);
      assert.equal(runLookup.status, 200);
      const lookupPayload = await runLookup.json();
      assert.equal(lookupPayload?.eval_run?.id, runId);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
