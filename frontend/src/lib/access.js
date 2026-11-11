// @ts-check
// Access levels: how much the assistant may do on this computer. The backend owns
// the setting (GET/PUT /api/access); the store keeps a copy for the composer chip.

import { apiFetch } from './api.js';

/** @typedef {'chat'|'read'|'ask'|'bypass'} AccessLevelId */
/** @typedef {'neutral'|'info'|'accent'|'danger'} AccessTone */

/**
 * @typedef {object} AccessLevel
 * @property {AccessLevelId} id
 * @property {string} label        full name, e.g. "Ask first"
 * @property {string} short        composer chip text, e.g. "Access: Ask"
 * @property {string} hint         one line for the composer menu
 * @property {AccessTone} tone
 * @property {boolean} canRead     reads files and system state
 * @property {'no'|'approval'|'yes'} canChange
 * @property {boolean} asks        pauses for the user before acting
 */

/**
 * @typedef {object} AccessSettings
 * @property {AccessLevelId} level
 * @property {string[]} allowCommands     user rules, used in Ask first only
 * @property {string[]} readOnlyPrograms  built-in read-only command names
 * @property {boolean} goDark
 * @property {string} sourceRoot          Mirabilis source folder
 * @property {string} dataDir             where access.json and run logs live
 */

/**
 * Lowest to highest. Ids and order match ACCESS_LEVELS in
 * backend/src/agent/permissions.js; the facts mirror its decision table.
 * @type {ReadonlyArray<Readonly<AccessLevel>>}
 */
export const ACCESS_LEVELS = Object.freeze([
  Object.freeze({
    id: 'chat',
    label: 'Chat only',
    short: 'Chat',
    hint: 'No computer access',
    tone: 'neutral',
    canRead: false,
    canChange: 'no',
    asks: false
  }),
  Object.freeze({
    id: 'read',
    label: 'Read only',
    short: 'Read',
    hint: 'Reads, never changes',
    tone: 'info',
    canRead: true,
    canChange: 'no',
    asks: false
  }),
  Object.freeze({
    id: 'ask',
    label: 'Ask first',
    short: 'Ask',
    hint: 'Asks before changes',
    tone: 'accent',
    canRead: true,
    canChange: 'approval',
    asks: true
  }),
  Object.freeze({
    id: 'bypass',
    label: 'Bypass',
    short: 'Bypass',
    hint: 'Runs anything, never asks',
    tone: 'danger',
    canRead: true,
    canChange: 'yes',
    asks: false
  })
]);

/** @type {AccessLevelId} */
export const DEFAULT_ACCESS = 'chat';

/**
 * CSS color per tone, shared by the composer chip and the Settings cards.
 * info is fixed: two schemes use their accent as --signal-blue, which would make
 * Read only and Ask first the same color there.
 */
export const ACCESS_TONE_COLOR = Object.freeze({
  neutral: 'var(--text-muted)',
  info: '#8b5cf6',
  accent: 'var(--accent)',
  danger: '#f43f5e'
});

/**
 * A valid level id; anything unknown falls back to Chat only, like the backend.
 * @param {unknown} value
 * @returns {AccessLevelId}
 */
export function normalizeAccess(value) {
  const hit = ACCESS_LEVELS.find((l) => l.id === value);
  return hit ? hit.id : DEFAULT_ACCESS;
}

/**
 * Metadata for a level id; unknown ids get Chat only.
 * @param {unknown} id
 * @returns {Readonly<AccessLevel>}
 */
export function accessMeta(id) {
  return ACCESS_LEVELS.find((l) => l.id === id) || ACCESS_LEVELS[0];
}

/**
 * The more restrictive of two levels, like lowerLevel in the backend.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {AccessLevelId}
 */
export function lowerAccess(a, b) {
  const ia = ACCESS_LEVELS.findIndex((l) => l.id === normalizeAccess(a));
  const ib = ACCESS_LEVELS.findIndex((l) => l.id === normalizeAccess(b));
  return ACCESS_LEVELS[Math.min(ia, ib)].id;
}

/** @param {unknown} value @returns {string[]} */
function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((s) => typeof s === 'string' && s.trim() !== '');
}

/**
 * Shapes a GET/PUT /api/access payload so the UI never trips on a missing field.
 * @param {any} payload
 * @returns {AccessSettings}
 */
export function normalizeAccessPayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  return {
    level: normalizeAccess(p.level),
    allowCommands: stringList(p.allowCommands),
    readOnlyPrograms: stringList(p.readOnlyPrograms),
    goDark: p.goDark === true,
    sourceRoot: typeof p.sourceRoot === 'string' ? p.sourceRoot : '',
    dataDir: typeof p.dataDir === 'string' ? p.dataDir : ''
  };
}

/**
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<AccessSettings>}
 */
export async function fetchAccess(opts = {}) {
  return normalizeAccessPayload(await apiFetch('/api/access', { signal: opts.signal }));
}

/**
 * Saves a level and/or the allowed command list; returns the stored result.
 * @param {{ level?: AccessLevelId, allowCommands?: string[] }} patch
 * @returns {Promise<AccessSettings>}
 */
export async function saveAccess(patch) {
  return normalizeAccessPayload(await apiFetch('/api/access', { method: 'PUT', body: patch }));
}

export const MAX_ALLOW_RULES = 200;
export const MAX_ALLOW_RULE_LENGTH = 120;

/**
 * Rules match on command words, so spacing is not meaningful.
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeAllowRule(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * Why a rule cannot be added, or '' when it can.
 * Shell operators never match: the backend splits commands on them first.
 * @param {string} rule normalized rule
 * @param {string[]} [existing]
 * @returns {string}
 */
export function allowRuleError(rule, existing = []) {
  if (!rule) return 'Enter a command.';
  if (rule.length > MAX_ALLOW_RULE_LENGTH) return `Too long. Use ${MAX_ALLOW_RULE_LENGTH} characters or fewer.`;
  if (/[|;&<>`\n]|\$\(/.test(rule)) return 'Remove shell operators (|, ;, &, <, >, backticks).';
  if (existing.includes(rule)) return 'Already on the list.';
  if (existing.length >= MAX_ALLOW_RULES) return `List is full (${MAX_ALLOW_RULES} max). Remove one first.`;
  return '';
}

/**
 * Plain sentence for a failed settings request.
 * apiFetch reports a missing route as a non-JSON 404, which means the backend
 * predates the feature.
 * @param {unknown} err
 * @param {string} [feature] what the request was for, e.g. "Connectors"
 * @returns {string}
 */
export function describeApiError(err, feature = 'this feature') {
  const e = /** @type {any} */ (err);
  const name = typeof e?.name === 'string' ? e.name : '';
  const message = typeof e?.message === 'string' ? e.message.trim() : '';
  if (name === 'AbortError') return 'Timed out. Try again.';
  if (name === 'TypeError' && /failed to fetch|load failed|networkerror/i.test(message)) {
    return 'Backend unreachable. Check that it is running.';
  }
  if (/^(Mirabilis returned a non-JSON response|Request failed) \(404\)/.test(message)) {
    return `Backend does not support ${feature}. Restart Mirabilis.`;
  }
  if (/^Unauthorized/.test(message)) return 'Session token rejected. Reload the app.';
  return message || 'Request failed. Try again.';
}
