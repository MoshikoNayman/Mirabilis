import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

import { createIntelLedgerStorage } from './storage/intelLedger.js';
import { createIntelLedgerRoutes } from './routes/intelLedger.js';

function createTestApp(storage, storePath) {
  const app = express();
  app.use(express.json());

  app.use('/api/intelledger', createIntelLedgerRoutes(storage, {
    streamWithProvider: async ({ messages, onToken }) => {
      const userPrompt = String(messages?.find((m) => m.role === 'user')?.content || '');
      if (userPrompt.includes('"signals"') || userPrompt.includes('Extract structured signals')) {
        onToken('{"signals":[{"type":"ask","value":"Send customer update by tomorrow.","owner":"Ops","due_date":"tomorrow","confidence":0.91}]}');
        return;
      }

      onToken('{"summary":"Session summary","key_decisions":[],"risks":[],"commitments":[],"opportunities":[],"next_actions":[],"open_questions":[]}');
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

test('prompt registry APIs drive prompt version metadata on extraction and synthesis', async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), 'mirabilis-prompt-registry-api-'));
  const storePath = join(tempDir, 'intelledger.json');
  const storage = createIntelLedgerStorage(storePath);
  await storage.ensureStore();
  const app = createTestApp(storage, storePath);

  try {
    await withServer(app, async (baseUrl) => {
      const createExtractVersion = await fetch(`${baseUrl}/api/intelledger/prompts/profiles/signal_extraction/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version_id: 'signal-extraction-v2',
          label: 'Signal Extraction v2',
          system_prompt: 'Extract signals JSON only.',
          user_template: 'Extract structured signals from this note. Return JSON only.\n{{content}}',
          set_active: true
        })
      });
      assert.equal(createExtractVersion.status, 201);

      const createSynthesisVersion = await fetch(`${baseUrl}/api/intelledger/prompts/profiles/session_synthesis/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version_id: 'session-synthesis-v2',
          label: 'Session Synthesis v2',
          system_prompt: 'Summarize session as strict JSON.',
          user_template: 'Goal: {{query}}\nInteractions:\n{{interactions}}\nSignals:\n{{signals}}',
          set_active: true
        })
      });
      assert.equal(createSynthesisVersion.status, 201);

      const createSessionRes = await fetch(`${baseUrl}/api/intelledger/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'prompt-user', title: 'Prompt metadata test' })
      });
      assert.equal(createSessionRes.status, 200);
      const createSessionPayload = await createSessionRes.json();
      const sessionId = createSessionPayload?.session?.id;
      assert.ok(sessionId);

      const ingestRes = await fetch(`${baseUrl}/api/intelledger/sessions/${sessionId}/ingest/text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Please send customer update by tomorrow.' })
      });
      assert.equal(ingestRes.status, 200);
      const ingestPayload = await ingestRes.json();
      assert.ok(Array.isArray(ingestPayload.signals));
      assert.equal(ingestPayload.signals[0].prompt_profile, 'signal_extraction');
      assert.equal(ingestPayload.signals[0].prompt_version, 'signal-extraction-v2');

      const synthesizeRes = await fetch(`${baseUrl}/api/intelledger/sessions/${sessionId}/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'Summarize key points.' })
      });
      assert.equal(synthesizeRes.status, 200);
      const synthesizePayload = await synthesizeRes.json();
      assert.equal(synthesizePayload?.synthesis?.prompt_profile, 'session_synthesis');
      assert.equal(synthesizePayload?.synthesis?.prompt_version, 'session-synthesis-v2');

      const profileRes = await fetch(`${baseUrl}/api/intelledger/prompts/profiles/session_synthesis`);
      assert.equal(profileRes.status, 200);
      const profilePayload = await profileRes.json();
      assert.equal(profilePayload?.profile?.active_version_id, 'session-synthesis-v2');
      assert.equal(Array.isArray(profilePayload?.profile?.versions), true);
      assert.equal(profilePayload.profile.versions.length, 1);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
