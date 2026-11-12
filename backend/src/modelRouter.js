// @ts-check
// Picks the best installed model for a task lane within the memory ceiling. A
// keyword classifier picks the lane so the hot path needs no model call. Lanes
// read the catalog groups in models.json, so a catalog update changes the picks
// with no code change.

import { catalogRowFor, getModels as getCatalogModels, UNCENSORED_NAME_RE } from './modelCatalog.js';

/** @typedef {import('./types.js').Lane} Lane */
/** @typedef {import('./types.js').RouteArgs} RouteArgs */
/** @typedef {import('./types.js').RouteResult} RouteResult */
/** @typedef {import('./types.js').AvailableModel} AvailableModel */

// Catalog groups per lane, in preference order.
/** @type {Record<Lane, string[]>} */
const LANE_GROUPS = {
  coding:       ['Coding'],
  reasoning:    ['Reasoning'],
  experimental: ['Uncensored'],
  general:      ['Small & Fast', 'Powerful']
};

// Only for models the catalog does not know at all: words that say what the
// model is for, so no model names to keep up to date.
/** @type {Record<Lane, string[]>} */
const LANE_WORDS = {
  coding:       ['code'],
  reasoning:    ['reason', 'think'],
  experimental: [],
  general:      []
};

const CODING_RE = /\b(code|function|bug|refactor|python|javascript|typescript|rust|golang|sql|regex|api|class|method|compile|stack ?trace|npm|git|docker|algorithm|leetcode|unit test|snippet)\b/i;
const REASONING_RE = /\b(reason|prove|step[- ]by[- ]step|think through|derive|logic|why does|explain how|trade[- ]?off|analyze|plan|strategy|math|calculate|solve)\b/i;

/** @param {string} [prompt] @returns {Lane} */
export function classifyLane(prompt) {
  const p = String(prompt || '');
  if (CODING_RE.test(p) || p.includes('```')) return 'coding';
  if (REASONING_RE.test(p)) return 'reasoning';
  return 'general';
}

/**
 * @typedef {object} Candidate
 * @property {string} id what the route returns
 * @property {string} lower
 * @property {number} sizeBytes
 * @property {string} group
 * @property {string[]} caps
 * @property {boolean} flagged uncensored: by the catalog, the caller or the name
 * @property {boolean} known its tag, or another tag of the same model, is in the catalog
 * @property {number} rank catalog position, other tags just after their row; Infinity when unknown
 * @property {number} given position in the caller's list
 */

/** @param {RouteArgs} [args] @returns {RouteResult} */
export function route({ prompt, lane, availableModels = [], ramGb = 16, uncensored = false, catalog } = {}) {
  const rows = catalog || getCatalogModels();

  // Catalog facts by exact tag (a bare name is :latest), else from another tag
  // of the same model; the caller's own group wins.
  const listed = (availableModels || []).filter((m) => m && (m.id || m.name));
  /** @type {Candidate[]} */
  const all = listed.map((m, given) => {
    const id = String(m.id || m.name);
    const match = catalogRowFor(id, rows);
    const row = match?.row;
    const group = m.group || row?.group || '';
    return {
      id,
      lower: id.toLowerCase(),
      sizeBytes: Number(m.sizeBytes) || 0,
      group,
      caps: Array.isArray(m.capabilities) ? m.capabilities : [],
      flagged: m.uncensored === true || row?.uncensored === true || group === 'Uncensored' || UNCENSORED_NAME_RE.test(id),
      known: Boolean(match),
      rank: row ? rows.indexOf(row) + (match?.exact ? 0 : 0.5) : Infinity,
      given
    };
  });
  const requested = lane && Object.hasOwn(LANE_GROUPS, lane) ? lane : null;
  if (!all.length) return { model: null, lane: requested || 'general', reason: 'no models installed' };

  // Explicit uncensored intent overrides the classifier.
  /** @type {Lane} */
  const resolvedLane = uncensored ? 'experimental' : (requested || classifyLane(prompt));

  // Embedders cannot chat.
  const chat = all.filter((c) => !(c.caps.includes('embedding') && !c.caps.includes('completion')) && !c.lower.includes('embed'));
  if (!chat.length) return { model: null, lane: resolvedLane, reason: 'only embedding models installed' };

  // Only consider models whose weights leave room to actually run (~weights + KV/OS).
  const runnable = chat.filter((c) => !c.sizeBytes || (c.sizeBytes / 1e9) < ramGb * 0.75);
  let pool = runnable.length ? runnable : chat;

  // Other lanes leave uncensored models alone while anything else is installed.
  if (resolvedLane !== 'experimental') {
    const tame = pool.filter((c) => !isExperimental(c));
    if (tame.length) pool = tame;
  }

  const lanePick = pickFor(resolvedLane, pool);
  if (lanePick) return { model: lanePick.hit.id, lane: resolvedLane, reason: `${lanePick.why} for ${resolvedLane}` };
  if (resolvedLane !== 'general') {
    const general = pickFor('general', pool);
    if (general) return { model: general.hit.id, lane: resolvedLane, reason: `no ${resolvedLane} model; fell back to ${general.why}` };
  }
  const biggest = [...pool].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
  return { model: biggest.id, lane: resolvedLane, reason: 'fell back to the largest fitting model' };
}

/** @param {Candidate} c */
function isExperimental(c) {
  return c.group === 'Uncensored' || c.flagged;
}

/** Catalog order, then the caller's order for models the catalog does not know. */
function first(/** @type {Candidate[]} */ list) {
  return [...list].sort((a, b) => (a.rank - b.rank) || (a.given - b.given))[0];
}

/**
 * The lane's pick: its catalog groups, then the lane's capability or flag,
 * then what the name says for models the catalog does not know.
 * @param {Lane} lane
 * @param {Candidate[]} pool
 * @returns {{ hit: Candidate, why: string } | null}
 */
function pickFor(lane, pool) {
  for (const group of LANE_GROUPS[lane]) {
    const hit = first(pool.filter((c) => c.group === group));
    if (hit) return { hit, why: `${group} group` };
  }
  if (lane === 'reasoning') {
    const hit = first(pool.filter((c) => c.caps.includes('thinking')));
    if (hit) return { hit, why: 'thinking capability' };
  }
  if (lane === 'experimental') {
    const hit = first(pool.filter((c) => c.flagged));
    if (hit) return { hit, why: 'uncensored flag' };
  }
  for (const word of LANE_WORDS[lane]) {
    const hit = pool.find((c) => !c.known && c.lower.includes(word));
    if (hit) return { hit, why: `"${word}" in the name` };
  }
  return null;
}
