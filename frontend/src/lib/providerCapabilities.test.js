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
    // The server-switch route rejects these providers.
    for (const p of ['openai', 'claude', 'gemini', 'groq', 'grok', 'openrouter', 'cerebras', 'gpuaas', 'vllm', 'llamacpp']) {
      expect(needsServerModelSwitch(p)).toBe(false);
    }
  });
});

describe('drift guard', () => {
  it('matches the allowlist the backend route actually enforces', () => {
    // Reads the real route so the two allowlists cannot drift apart.
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
