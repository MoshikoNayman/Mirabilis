// @ts-check
// Effort options, names and the agent count, shared by the composer and the run strip.
// Agentic ids and agent limits mirror backend/src/agent/effortProfiles.js; effort.test.js checks.

/**
 * @typedef {object} EffortOption
 * @property {string} value
 * @property {string} label
 * @property {boolean} [agentic]  Send starts a budgeted run instead of a chat turn
 */

/**
 * Menu order. The first five are prompt hints on a single request; the agentic
 * ones run the backend loop with a hard budget via /api/agent/runs.
 * @type {ReadonlyArray<Readonly<EffortOption>>}
 */
export const EFFORT_OPTIONS = Object.freeze([
  { value: 'instant',  label: 'Instant' },
  { value: 'fast',     label: 'Fast' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'thorough', label: 'Thorough' },
  { value: 'deep',     label: 'Deep' },
  { value: 'high',     label: 'High', agentic: true },
  { value: 'hour',     label: '1 hour', agentic: true },
  { value: 'session',  label: '5 hours', agentic: true },
  { value: 'ultra',    label: 'Ultra', agentic: true }
].map((o) => Object.freeze(o)));

/** @type {ReadonlySet<string>} */
export const AGENTIC_EFFORTS = new Set(EFFORT_OPTIONS.filter((o) => o.agentic).map((o) => o.value));

/** @type {Readonly<Record<string, string>>} */
export const EFFORT_LABELS = Object.freeze(Object.fromEntries(EFFORT_OPTIONS.map((o) => [o.value, o.label])));

/**
 * Sub-agents per tier: the default and the cap, which is the tier's maxSubAgents.
 * The 1 hour and 5 hours defaults are their caps, so a run changes only when the user sets a count.
 * @type {Readonly<Record<string, Readonly<{ def: number, max: number }>>>}
 */
export const AGENT_LIMITS = Object.freeze({
  hour: Object.freeze({ def: 3, max: 3 }),
  session: Object.freeze({ def: 6, max: 6 }),
  ultra: Object.freeze({ def: 4, max: 8 })
});

/** @param {unknown} effort */
const limitsFor = (effort) => (typeof effort === 'string' && Object.hasOwn(AGENT_LIMITS, effort) ? AGENT_LIMITS[effort] : null);

/**
 * A known effort id; anything else, a stale saved value included, is Balanced.
 * @param {unknown} id
 * @returns {string}
 */
export function normalizeEffort(id) {
  const hit = EFFORT_OPTIONS.find((o) => o.value === id);
  return hit ? hit.value : 'balanced';
}

/**
 * The saved agent count, '1' to '8' in storage; anything else is null.
 * @param {unknown} raw
 * @returns {number|null}
 */
export function parseSavedAgents(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^[1-8]$/.test(s) ? Number(s) : null;
}

/**
 * Most agents a run of this effort may start; 0 hides the Agents control.
 * At Chat only 1 hour and 5 hours have no tools to fan out with, while Ultra splits in code.
 * @param {unknown} effort
 * @param {unknown} access
 * @returns {number}
 */
export function agentMax(effort, access) {
  const limits = limitsFor(effort);
  if (!limits || (access === 'chat' && effort !== 'ultra')) return 0;
  return limits.max;
}

/**
 * Agents the next run gets: the saved count, else the tier default, within the cap.
 * @param {unknown} effort
 * @param {number|null|undefined} saved  from parseSavedAgents
 * @param {unknown} access
 * @returns {number} 1 when the run works alone
 */
export function agentCount(effort, saved, access) {
  const max = agentMax(effort, access);
  if (max === 0) return 1;
  const n = typeof saved === 'number' && Number.isInteger(saved) ? saved : (limitsFor(effort)?.def ?? max);
  return Math.min(max, Math.max(1, n));
}

/**
 * Overrides for POST /api/agent/runs, or null when the effort has no Agents control.
 * One agent goes out as 0, so the run never builds the spawn tool.
 * @param {unknown} effort
 * @param {number|null|undefined} saved
 * @param {unknown} access
 * @returns {{ maxSubAgents: number }|null}
 */
export function agentOverrides(effort, saved, access) {
  if (agentMax(effort, access) === 0) return null;
  const n = agentCount(effort, saved, access);
  return { maxSubAgents: n > 1 ? n : 0 };
}

/**
 * Composer chip text after "Effort: ", e.g. "Ultra, 4 agents". Spelled out: "x3"
 * after "1 hour" reads as three hours.
 * @param {unknown} effort
 * @param {number|null|undefined} saved
 * @param {unknown} access
 * @returns {string}
 */
export function effortChipText(effort, saved, access) {
  const label = EFFORT_LABELS[normalizeEffort(effort)];
  const n = agentCount(effort, saved, access);
  return n > 1 ? `${label}, ${n} agents` : label;
}
