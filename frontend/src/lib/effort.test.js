import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import {
  EFFORT_OPTIONS, AGENTIC_EFFORTS, EFFORT_LABELS, AGENT_LIMITS, normalizeEffort, parseSavedAgents,
  agentMax, agentCount, agentOverrides, effortChipText
} from './effort.js';

describe('EFFORT_OPTIONS', () => {
  it('lists each effort once, Ultra last, with plain ASCII labels and no hints', () => {
    const values = EFFORT_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values.at(-1)).toBe('ultra');
    for (const opt of EFFORT_OPTIONS) {
      expect(/^[\x20-\x7e]+$/.test(opt.label), opt.value).toBe(true);
      expect(opt, opt.value).not.toHaveProperty('hint');
    }
  });

  it('names every option, Ultra included', () => {
    expect(Object.keys(EFFORT_LABELS)).toEqual(EFFORT_OPTIONS.map((o) => o.value));
    for (const opt of EFFORT_OPTIONS) expect(EFFORT_LABELS[opt.value]).toBe(opt.label);
    expect(EFFORT_LABELS.ultra).toBe('Ultra');
  });

  it('marks the tiers that start a run', () => {
    expect([...AGENTIC_EFFORTS].sort()).toEqual(['high', 'hour', 'session', 'ultra']);
  });

  it('cannot be changed at runtime', () => {
    expect(Object.isFrozen(EFFORT_OPTIONS)).toBe(true);
    for (const opt of EFFORT_OPTIONS) expect(Object.isFrozen(opt)).toBe(true);
    expect(Object.isFrozen(EFFORT_LABELS)).toBe(true);
    expect(Object.isFrozen(AGENT_LIMITS)).toBe(true);
    for (const limits of Object.values(AGENT_LIMITS)) expect(Object.isFrozen(limits)).toBe(true);
  });
});

describe('normalizeEffort', () => {
  it('keeps a known id and turns anything else into Balanced', () => {
    expect(normalizeEffort('ultra')).toBe('ultra');
    expect(normalizeEffort('hour')).toBe('hour');
    for (const bad of ['nope', 'Ultra', '', undefined, null, 3, 'constructor']) {
      expect(normalizeEffort(bad)).toBe('balanced');
    }
  });
});

describe('parseSavedAgents', () => {
  it('reads one digit from 1 to 8', () => {
    expect(parseSavedAgents('3')).toBe(3);
    expect(parseSavedAgents('8')).toBe(8);
    expect(parseSavedAgents(' 2 ')).toBe(2);
  });

  it('is null for anything else', () => {
    for (const bad of ['', 'abc', '0', '9', '-2', '2.5', '08', null, undefined, 3]) {
      expect(parseSavedAgents(bad), String(bad)).toBeNull();
    }
  });
});

describe('agent count', () => {
  it('shows the control for the fan-out tiers, and for Ultra even at Chat only', () => {
    expect(agentMax('ultra', 'chat')).toBe(8);
    expect(agentMax('hour', 'read')).toBe(3);
    expect(agentMax('hour', 'chat')).toBe(0);
    expect(agentMax('session', 'bypass')).toBe(6);
    expect(agentMax('high', 'read')).toBe(0);
    expect(agentMax('balanced', 'read')).toBe(0);
    expect(agentMax('constructor', 'read')).toBe(0);
  });

  it('uses the saved count, else the tier default, within the tier cap', () => {
    expect(agentCount('ultra', null, 'read')).toBe(4);
    expect(agentCount('hour', null, 'read')).toBe(3);
    expect(agentCount('session', null, 'read')).toBe(6);
    expect(agentCount('hour', 8, 'read')).toBe(3);
    expect(agentCount('ultra', 1, 'read')).toBe(1);
    expect(agentCount('high', 5, 'read')).toBe(1);
    expect(agentCount('hour', 5, 'chat')).toBe(1);
    expect(agentCount('ultra', 2.5, 'read')).toBe(4);
  });

  it('sends the count as overrides, one agent as none', () => {
    expect(agentOverrides('ultra', 1, 'read')).toEqual({ maxSubAgents: 0 });
    expect(agentOverrides('ultra', 5, 'read')).toEqual({ maxSubAgents: 5 });
    expect(agentOverrides('hour', null, 'read')).toEqual({ maxSubAgents: 3 });
    expect(agentOverrides('hour', null, 'chat')).toBeNull();
    expect(agentOverrides('high', 4, 'read')).toBeNull();
  });

  it('writes the chip text with the count spelled out', () => {
    expect(effortChipText('ultra', null, 'chat')).toBe('Ultra, 4 agents');
    expect(effortChipText('hour', null, 'read')).toBe('1 hour, 3 agents');
    expect(effortChipText('hour', null, 'chat')).toBe('1 hour');
    expect(effortChipText('ultra', 1, 'read')).toBe('Ultra');
    expect(effortChipText('high', 4, 'read')).toBe('High');
    expect(effortChipText('nope', 4, 'read')).toBe('Balanced');
  });
});

describe('backend tiers', () => {
  it('match the options and agent limits when the backend module exists', async () => {
    const file = new URL('../../../backend/src/agent/effortProfiles.js', import.meta.url);
    // Skip quietly when the frontend is checked out alone; a module that is there must load.
    if (!existsSync(file)) return;
    const { EFFORT_PROFILES, EFFORT_ORDER } = await import(file.href);
    for (const opt of EFFORT_OPTIONS.filter((o) => o.agentic)) {
      expect(EFFORT_PROFILES[opt.value]?.agentic, opt.value).toBe(true);
    }
    for (const id of ['hour', 'session', 'ultra']) {
      expect(AGENT_LIMITS[id].max, id).toBe(EFFORT_PROFILES[id].maxSubAgents);
    }
    for (const [id, profile] of Object.entries(EFFORT_PROFILES)) {
      if (profile.agentic && profile.maxSubAgents === 0) expect(AGENT_LIMITS[id], id).toBeUndefined();
    }
    const values = EFFORT_OPTIONS.map((o) => o.value);
    for (const id of EFFORT_ORDER) expect(values, id).toContain(id);
    // Deep is a prompt hint on a chat turn, not a backend tier.
    expect(EFFORT_PROFILES.deep).toBeUndefined();
  });
});
