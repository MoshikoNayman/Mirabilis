import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

import { createIntelLedgerStorage } from './storage/intelLedger.js';

test('prompt registry supports create/list/select and fallback resolution', async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), 'mirabilis-prompt-registry-'));
  const storePath = join(tempDir, 'intelledger.json');
  const storage = createIntelLedgerStorage(storePath);

  try {
    await storage.ensureStore();

    const fallback = await storage.resolvePromptVersion('signal_extraction', {
      id: 'signal-extraction-default-v1',
      label: 'Signal Extraction Default',
      system_prompt: 'sys',
      user_template: 'tmpl {{content}}'
    });
    assert.equal(fallback.is_fallback, true);
    assert.equal(fallback.id, 'signal-extraction-default-v1');

    await storage.createPromptVersion('signal_extraction', {
      version_id: 'signal-extraction-v2',
      label: 'Signal Extraction v2',
      system_prompt: 'system-v2',
      user_template: 'template-v2 {{content}}',
      set_active: true
    });

    await storage.createPromptVersion('signal_extraction', {
      version_id: 'signal-extraction-v3',
      label: 'Signal Extraction v3',
      system_prompt: 'system-v3',
      user_template: 'template-v3 {{content}}',
      set_active: false
    });

    const selected = await storage.selectPromptVersion('signal_extraction', 'signal-extraction-v3');
    assert.ok(selected);
    assert.equal(selected.active_version_id, 'signal-extraction-v3');

    const profile = await storage.getPromptProfile('signal_extraction');
    assert.ok(profile);
    assert.equal(profile.active_version_id, 'signal-extraction-v3');
    assert.equal(profile.versions.length, 2);

    const listed = await storage.listPromptProfiles();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].profile_id, 'signal_extraction');
    assert.equal(listed[0].version_count, 2);

    const resolved = await storage.resolvePromptVersion('signal_extraction', {
      id: 'signal-extraction-default-v1',
      label: 'Signal Extraction Default',
      system_prompt: 'sys',
      user_template: 'tmpl {{content}}'
    });
    assert.equal(resolved.is_fallback, false);
    assert.equal(resolved.id, 'signal-extraction-v3');
    assert.equal(resolved.system_prompt, 'system-v3');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
