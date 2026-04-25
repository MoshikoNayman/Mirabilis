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
      onToken('{"signals":[]}');
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

test('strict pii_mode redacts email and phone during text ingest', async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), 'mirabilis-pii-strict-'));
  const storePath = join(tempDir, 'intelledger.json');
  const storage = createIntelLedgerStorage(storePath);
  await storage.ensureStore();
  const app = createApp(storage, storePath);

  try {
    await withServer(app, async (baseUrl) => {
      const createSessionRes = await fetch(`${baseUrl}/api/intelledger/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'pii-user', title: 'PII strict mode' })
      });
      assert.equal(createSessionRes.status, 200);
      const sessionId = (await createSessionRes.json())?.session?.id;
      assert.ok(sessionId);

      const updatePolicyRes = await fetch(`${baseUrl}/api/intelledger/sessions/${sessionId}/retention`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pii_mode: 'strict' })
      });
      assert.equal(updatePolicyRes.status, 200);

      const ingestRes = await fetch(`${baseUrl}/api/intelledger/sessions/${sessionId}/ingest/text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'Contact john.doe@example.com or call 415-555-0123 before noon.'
        })
      });
      assert.equal(ingestRes.status, 200);

      const interactionsRes = await fetch(`${baseUrl}/api/intelledger/sessions/${sessionId}/interactions`);
      assert.equal(interactionsRes.status, 200);
      const interactions = (await interactionsRes.json())?.interactions || [];
      assert.equal(interactions.length > 0, true);

      const raw = String(interactions[0].raw_content || '');
      assert.equal(raw.includes('john.doe@example.com'), false);
      assert.equal(raw.includes('415-555-0123'), false);
      assert.equal(raw.includes('[REDACTED_EMAIL]'), true);
      assert.equal(raw.includes('[REDACTED_PHONE]'), true);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
