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
      onToken('{"summary":"ok","key_decisions":[],"risks":[],"commitments":[],"opportunities":[],"next_actions":[],"open_questions":[]}');
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

test('hardening guardrails enforce payload limits and record policy audit events', async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), 'mirabilis-hardening-api-'));
  const storePath = join(tempDir, 'intelledger.json');
  const storage = createIntelLedgerStorage(storePath);
  await storage.ensureStore();

  const previousEnv = {
    INTELLEDGER_MAX_TEXT_INGEST_CHARS: process.env.INTELLEDGER_MAX_TEXT_INGEST_CHARS,
    INTELLEDGER_MAX_SYNTHESIS_QUERY_CHARS: process.env.INTELLEDGER_MAX_SYNTHESIS_QUERY_CHARS,
    INTELLEDGER_MAX_CROSS_SYNTH_SESSIONS: process.env.INTELLEDGER_MAX_CROSS_SYNTH_SESSIONS
  };

  process.env.INTELLEDGER_MAX_TEXT_INGEST_CHARS = '20';
  process.env.INTELLEDGER_MAX_SYNTHESIS_QUERY_CHARS = '16';
  process.env.INTELLEDGER_MAX_CROSS_SYNTH_SESSIONS = '1';

  const app = createApp(storage, storePath);

  try {
    await withServer(app, async (baseUrl) => {
      const createSessionA = await fetch(`${baseUrl}/api/intelledger/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'hardening-user', title: 'Hardening A' })
      });
      const createSessionB = await fetch(`${baseUrl}/api/intelledger/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'hardening-user', title: 'Hardening B' })
      });

      const sessionA = (await createSessionA.json())?.session;
      const sessionB = (await createSessionB.json())?.session;
      assert.ok(sessionA?.id);
      assert.ok(sessionB?.id);

      const tooLargeIngest = await fetch(`${baseUrl}/api/intelledger/sessions/${sessionA.id}/ingest/text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'This content is way too long for the configured cap.' })
      });
      assert.equal(tooLargeIngest.status, 413);

      const tooLargeSynthesisQuery = await fetch(`${baseUrl}/api/intelledger/sessions/${sessionA.id}/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'this query exceeds sixteen chars' })
      });
      assert.equal(tooLargeSynthesisQuery.status, 413);

      const tooManyCrossSessions = await fetch(`${baseUrl}/api/intelledger/sessions/cross-synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'hardening-user',
          sessionIds: [sessionA.id, sessionB.id],
          query: 'ok'
        })
      });
      assert.equal(tooManyCrossSessions.status, 400);

      const updatePolicy = await fetch(`${baseUrl}/api/intelledger/sessions/${sessionA.id}/retention`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ retention_days: 5, pii_mode: 'strict', pii_retention_action: 'hash' })
      });
      assert.equal(updatePolicy.status, 200);

      const runPolicy = await fetch(`${baseUrl}/api/intelledger/sessions/${sessionA.id}/retention/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ retention_days: 5 })
      });
      assert.equal(runPolicy.status, 200);

      const auditFeed = await fetch(`${baseUrl}/api/intelledger/sessions/${sessionA.id}/audit?limit=20`);
      assert.equal(auditFeed.status, 200);
      const auditPayload = await auditFeed.json();
      assert.ok(Array.isArray(auditPayload?.events));

      const eventTypes = new Set(auditPayload.events.map((item) => item.event_type));
      assert.equal(eventTypes.has('session.retention_policy_updated'), true);
      assert.equal(eventTypes.has('session.retention_run_executed'), true);
    });
  } finally {
    if (previousEnv.INTELLEDGER_MAX_TEXT_INGEST_CHARS === undefined) delete process.env.INTELLEDGER_MAX_TEXT_INGEST_CHARS;
    else process.env.INTELLEDGER_MAX_TEXT_INGEST_CHARS = previousEnv.INTELLEDGER_MAX_TEXT_INGEST_CHARS;

    if (previousEnv.INTELLEDGER_MAX_SYNTHESIS_QUERY_CHARS === undefined) delete process.env.INTELLEDGER_MAX_SYNTHESIS_QUERY_CHARS;
    else process.env.INTELLEDGER_MAX_SYNTHESIS_QUERY_CHARS = previousEnv.INTELLEDGER_MAX_SYNTHESIS_QUERY_CHARS;

    if (previousEnv.INTELLEDGER_MAX_CROSS_SYNTH_SESSIONS === undefined) delete process.env.INTELLEDGER_MAX_CROSS_SYNTH_SESSIONS;
    else process.env.INTELLEDGER_MAX_CROSS_SYNTH_SESSIONS = previousEnv.INTELLEDGER_MAX_CROSS_SYNTH_SESSIONS;

    await rm(tempDir, { recursive: true, force: true });
  }
});
