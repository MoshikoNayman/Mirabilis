import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SERVER_MODEL_SWITCH_PROVIDERS, needsServerModelSwitch } from './providerCapabilities.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '../../../backend/src/server.js');

describe('needsServerModelSwitch', () => {
  it('is true only for the locally hosted GGUF servers', () => {
    expect(needsServerModelSwitch('openai-compatible')).toBe(true);
    expect(needsServerModelSwitch('koboldcpp')).toBe(true);
  });

  it('is false for every cloud provider, which just carries the model id per request', () => {
    // The bug: the picker POSTed all of these to a route that rejects them, so
    // picking a model was impossible for ten providers.
    for (const p of ['openai', 'claude', 'gemini', 'groq', 'grok', 'openrouter', 'cerebras', 'gpuaas', 'vllm', 'llamacpp']) {
      expect(needsServerModelSwitch(p)).toBe(false);
    }
  });
});

describe('drift guard', () => {
  it('matches the allowlist the backend route actually enforces', () => {
    // Reads the real route. If someone adds a provider to the backend allowlist
    // and not here, the picker silently stops offering a server switch for it;
    // if they add it here only, every click 400s. Both fail this test instead.
    const src = readFileSync(SERVER, 'utf8');
    const route = src.slice(src.indexOf("app.post('/api/providers/switch-model'"));
    const match = route.match(/if \(!\[([^\]]+)\]\.includes\(provider\)\)/);
    expect(match, 'could not find the allowlist in the switch-model route').toBeTruthy();
    const backendList = match[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    expect([...backendList].sort()).toEqual([...SERVER_MODEL_SWITCH_PROVIDERS].sort());
  });
});
