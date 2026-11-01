import { describe, it, expect } from 'vitest';
import {
  restoreToolPolicy, needsFullAcknowledgement, describeRunError,
  SAFE_POLICY, DEFAULT_POLICY
} from './agentRunPolicy.js';

describe('restoreToolPolicy', () => {
  it('never restores full from a previous session', () => {
    // The acknowledgement is per session, so a restored `full` would be refused.
    expect(restoreToolPolicy('full')).toBe(SAFE_POLICY);
    expect(restoreToolPolicy('full')).not.toBe('full');
  });

  it('restores the safe policies unchanged', () => {
    expect(restoreToolPolicy('read-only')).toBe('read-only');
    expect(restoreToolPolicy('write')).toBe('write');
  });

  it('falls back to the default for anything unrecognised', () => {
    for (const bad of ['', 'root', 'FULL', null, undefined, 7, {}]) {
      expect(restoreToolPolicy(bad)).toBe(DEFAULT_POLICY);
    }
  });
});

describe('needsFullAcknowledgement', () => {
  it('asks when full has not been acknowledged this session', () => {
    expect(needsFullAcknowledgement('full', false)).toBe(true);
    expect(needsFullAcknowledgement('full', undefined)).toBe(true);
  });

  it('does not ask once acknowledged', () => {
    expect(needsFullAcknowledgement('full', true)).toBe(false);
  });

  it('never asks for the policies that do not open a shell', () => {
    expect(needsFullAcknowledgement('read-only', false)).toBe(false);
    expect(needsFullAcknowledgement('write', false)).toBe(false);
  });
});

describe('describeRunError', () => {
  it('reads the sentence the server sent instead of dumping JSON', () => {
    const body = JSON.stringify({
      error: 'The "full" tool policy lets this run execute shell commands unattended.',
      requiresAcknowledgement: 'full-policy'
    });
    expect(describeRunError(400, body)).toBe(
      'The "full" tool policy lets this run execute shell commands unattended.'
    );
  });

  it('does not show a JSON payload when there is no error field', () => {
    const out = describeRunError(500, JSON.stringify({ oops: true, stack: 'x'.repeat(50) }));
    expect(out).not.toContain('{');
    expect(out).toContain('500');
  });

  it('keeps a short plain-text body', () => {
    expect(describeRunError(503, 'Engine is starting up')).toBe('Engine is starting up');
  });

  it('falls back to the status when the body is empty or unusable', () => {
    expect(describeRunError(502, '')).toContain('502');
    expect(describeRunError(502, '   ')).toContain('502');
    expect(describeRunError(400, 'x'.repeat(500))).toContain('400');
  });
});
