import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ACCESS_LEVELS, ACCESS_TONE_COLOR, DEFAULT_ACCESS, accessMeta, lowerAccess, normalizeAccess,
  normalizeAccessPayload, normalizeAllowRule, allowRuleError, describeApiError,
  MAX_ALLOW_RULES, MAX_ALLOW_RULE_LENGTH
} from './access.js';

describe('ACCESS_LEVELS', () => {
  it('lists the four levels from least to most power', () => {
    expect(ACCESS_LEVELS.map((l) => l.id)).toEqual(['chat', 'read', 'ask', 'bypass']);
  });

  it('gives every level a label, a short chip label and a known tone', () => {
    const ids = new Set();
    for (const level of ACCESS_LEVELS) {
      expect(ids.has(level.id)).toBe(false);
      ids.add(level.id);
      expect(level.label.trim()).not.toBe('');
      expect(level.short.trim()).not.toBe('');
      expect(level.short.length).toBeLessThanOrEqual(level.label.length);
      expect(Object.keys(ACCESS_TONE_COLOR)).toContain(level.tone);
    }
  });

  it('marks only Bypass as danger', () => {
    expect(ACCESS_LEVELS.filter((l) => l.tone === 'danger').map((l) => l.id)).toEqual(['bypass']);
  });

  it('states what each level can do, matching the backend decision table', () => {
    const facts = Object.fromEntries(ACCESS_LEVELS.map((l) => [l.id, [l.canRead, l.canChange, l.asks]]));
    expect(facts).toEqual({
      chat: [false, 'no', false],
      read: [true, 'no', false],
      ask: [true, 'approval', true],
      bypass: [true, 'yes', false]
    });
  });

  it('cannot be changed at runtime', () => {
    expect(Object.isFrozen(ACCESS_LEVELS)).toBe(true);
    for (const level of ACCESS_LEVELS) expect(Object.isFrozen(level)).toBe(true);
  });

  it('keeps UI text plain ASCII', () => {
    for (const level of ACCESS_LEVELS) {
      for (const text of [level.label, level.short]) {
        expect(/^[\x20-\x7e]*$/.test(text)).toBe(true);
      }
    }
  });

  it('matches the backend level ids and order when the backend module exists', () => {
    // permissions.js is the backend's list; skip quietly if it is not there yet.
    let src = '';
    try {
      src = readFileSync(new URL('../../../backend/src/agent/permissions.js', import.meta.url), 'utf8');
    } catch {
      return;
    }
    const start = src.indexOf('export const ACCESS_LEVELS');
    expect(start, 'ACCESS_LEVELS is not exported from permissions.js').toBeGreaterThan(-1);
    const statement = src.slice(start).split(/;|\n\s*\n/)[0];
    const backend = [...statement.matchAll(/['"]([a-z]+)['"]/g)].map((m) => m[1]);
    // A list built from another constant has no literals here; nothing to compare.
    if (backend.length === 0) return;
    expect(backend).toEqual(ACCESS_LEVELS.map((l) => l.id));
  });
});

describe('accessMeta', () => {
  it('returns the matching level', () => {
    for (const level of ACCESS_LEVELS) expect(accessMeta(level.id)).toBe(level);
    expect(accessMeta('bypass').label).toBe('Bypass permissions');
    expect(accessMeta('ask').short).toBe('Ask');
  });

  it('falls back to Chat only for anything unknown', () => {
    for (const bad of ['', 'BYPASS', 'full', 'root', null, undefined, 3, {}, []]) {
      expect(accessMeta(bad).id).toBe('chat');
    }
  });
});

describe('lowerAccess', () => {
  it('picks the more restrictive level, in either order', () => {
    expect(lowerAccess('bypass', 'read')).toBe('read');
    expect(lowerAccess('read', 'bypass')).toBe('read');
    expect(lowerAccess('ask', 'ask')).toBe('ask');
    expect(lowerAccess('chat', 'bypass')).toBe('chat');
  });

  it('treats an unknown level as Chat only, like the backend', () => {
    expect(lowerAccess('bypass', 'root')).toBe('chat');
    expect(lowerAccess(undefined, 'ask')).toBe('chat');
  });
});

describe('ACCESS_TONE_COLOR', () => {
  it('gives Read only a color of its own, never the scheme accent', () => {
    // Arctic and Summit set --signal-blue to their accent, so a variable here would match Ask first.
    expect(ACCESS_TONE_COLOR.info).not.toMatch(/var\(/);
    expect(ACCESS_TONE_COLOR.info).not.toBe(ACCESS_TONE_COLOR.accent);
    expect(new Set(Object.values(ACCESS_TONE_COLOR)).size).toBe(Object.keys(ACCESS_TONE_COLOR).length);
  });
});

describe('normalizeAccess', () => {
  it('keeps valid ids and defaults the rest to chat', () => {
    expect(DEFAULT_ACCESS).toBe('chat');
    expect(normalizeAccess('read')).toBe('read');
    expect(normalizeAccess('bypass')).toBe('bypass');
    expect(normalizeAccess('Bypass')).toBe('chat');
    expect(normalizeAccess(undefined)).toBe('chat');
  });
});

describe('normalizeAccessPayload', () => {
  it('passes a full payload through', () => {
    const out = normalizeAccessPayload({
      level: 'ask',
      levels: [],
      allowCommands: ['git status', 'npm test'],
      readOnlyPrograms: ['ls', 'ps'],
      goDark: true,
      sourceRoot: '/src/mirabilis',
      dataDir: '/data'
    });
    expect(out).toEqual({
      level: 'ask',
      allowCommands: ['git status', 'npm test'],
      readOnlyPrograms: ['ls', 'ps'],
      goDark: true,
      sourceRoot: '/src/mirabilis',
      dataDir: '/data'
    });
  });

  it('fills safe defaults for missing or malformed fields', () => {
    for (const bad of [null, undefined, 'x', 42, { level: 'root', allowCommands: 'git status', goDark: 'yes' }]) {
      expect(normalizeAccessPayload(bad)).toEqual({
        level: 'chat', allowCommands: [], readOnlyPrograms: [], goDark: false, sourceRoot: '', dataDir: ''
      });
    }
  });

  it('drops non-string and blank list entries', () => {
    const out = normalizeAccessPayload({ allowCommands: ['ls', '', '  ', 7, null, 'git log'] });
    expect(out.allowCommands).toEqual(['ls', 'git log']);
  });
});

describe('allow rules', () => {
  it('normalizes spacing', () => {
    expect(normalizeAllowRule('  git   status  ')).toBe('git status');
    expect(normalizeAllowRule(null)).toBe('');
  });

  it('accepts a plain command prefix', () => {
    expect(allowRuleError('brew services', ['git status'])).toBe('');
  });

  it('rejects empty, long, duplicate and operator-laden rules', () => {
    expect(allowRuleError('')).not.toBe('');
    expect(allowRuleError('x'.repeat(MAX_ALLOW_RULE_LENGTH + 1))).toMatch(/120/);
    expect(allowRuleError('x'.repeat(MAX_ALLOW_RULE_LENGTH))).toBe('');
    expect(allowRuleError('git status', ['git status'])).toMatch(/Already on the list/);
    for (const bad of ['ls | sh', 'ls; rm x', 'a && b', 'echo > f', 'cat < f', 'ls `x`', 'ls $(x)']) {
      expect(allowRuleError(bad), bad).not.toBe('');
    }
  });

  it('caps the list size', () => {
    const full = Array.from({ length: MAX_ALLOW_RULES }, (_, i) => `cmd${i}`);
    expect(allowRuleError('another', full)).toMatch(/200/);
  });
});

describe('describeApiError', () => {
  it('explains a backend that predates the route', () => {
    const msg = describeApiError(new Error('Mirabilis returned a non-JSON response (404).'), 'Connectors');
    expect(msg).toMatch(/does not support Connectors/);
  });

  it('explains an unreachable backend and a timeout', () => {
    const net = new TypeError('Failed to fetch');
    expect(describeApiError(net)).toMatch(/Backend unreachable/);
    const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    expect(describeApiError(abort)).toMatch(/Timed out/);
  });

  it('keeps the server sentence otherwise', () => {
    expect(describeApiError(new Error('Connector not found'))).toBe('Connector not found');
    expect(describeApiError(null)).not.toBe('');
  });
});
