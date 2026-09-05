import { describe, it, expect } from 'vitest';
import {
  hasUsableKey, providerNeedsKey, providerLabel, missingKeyMessage, KEY_REQUIRED_PROVIDERS
} from './providerKeys.js';

describe('hasUsableKey', () => {
  it('accepts a key the BACKEND holds, which is where keys live now', () => {
    // The defect: after keys moved to the backend, the send path still asked
    // the page for its copy, which nothing populated any more. Saving a key
    // made the settings panel say "Stored in the app" while every send was
    // refused, and re-saving could never help.
    for (const p of KEY_REQUIRED_PROVIDERS) {
      expect(hasUsableKey(p, { pageKey: '', hints: { [p]: { hasKey: true } } })).toBe(true);
    }
  });

  it('still accepts a page-held key, for the legacy and in-session case', () => {
    expect(hasUsableKey('openai', { pageKey: 'sk-abc', hints: {} })).toBe(true);
    expect(hasUsableKey('openai', { pageKey: '   sk-abc  ', hints: {} })).toBe(true);
  });

  it('refuses only when neither place has one', () => {
    expect(hasUsableKey('openai', { pageKey: '', hints: {} })).toBe(false);
    expect(hasUsableKey('openai', { pageKey: '   ', hints: { openai: { hasKey: false } } })).toBe(false);
  });

  it('never blocks a provider that does not need a key', () => {
    for (const p of ['ollama', 'llamacpp', 'vllm', 'koboldcpp', 'openai-compatible']) {
      expect(hasUsableKey(p, { pageKey: '', hints: {} })).toBe(true);
    }
  });

  it('survives missing or malformed hint data', () => {
    expect(hasUsableKey('openai', {})).toBe(false);
    expect(hasUsableKey('openai', { hints: null })).toBe(false);
    expect(hasUsableKey('openai', { hints: { openai: {} } })).toBe(false);
    expect(hasUsableKey('openai', { hints: { openai: { hasKey: 'yes' } } })).toBe(false);
  });
});

describe('providerNeedsKey', () => {
  it('covers every cloud provider the send path used to list by hand', () => {
    for (const p of ['openai', 'grok', 'groq', 'openrouter', 'gemini', 'cerebras', 'claude', 'gpuaas']) {
      expect(providerNeedsKey(p)).toBe(true);
    }
    expect(providerNeedsKey('ollama')).toBe(false);
  });
});

describe('messages', () => {
  it('names the vendor, not the internal id', () => {
    expect(providerLabel('grok')).toBe('xAI');
    expect(providerLabel('claude')).toBe('Anthropic');
    expect(missingKeyMessage('gemini')).toContain('Google AI');
  });
});
