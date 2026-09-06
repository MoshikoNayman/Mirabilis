// @ts-check
// backend/src/modelCatalog.js
// Where the suggested-model list comes from.
//
// It used to be a hardcoded array in modelService.js, which meant every new
// model upstream was a code change, a commit and an app update for every user.
// That is the wrong shape for a list whose whole purpose is to track something
// that moves weekly.
//
// Three sources, merged in this order, later wins:
//
//   1. bundled     backend/models.json, ships with the app. Always works:
//                  offline, first run, and under Go Dark.
//   2. remote      the same file from the repository, refreshed in the
//                  background. Editing that one file updates every install.
//   3. user        ~/.mirabilis/models.json, so someone can add their own
//                  without waiting for anyone.
//
// The remote copy is a convenience, never a dependency. If it is unreachable,
// malformed, or blocked by Go Dark, the bundled list is used and nothing about
// the app degrades.
//
// This list only SUGGESTS. It is not a permission gate: the pull route already
// validates model ids by format and accepts any well-formed name, so a bad
// entry here cannot cause anything the user could not already type themselves.

import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const BUNDLED_CATALOG_PATH = path.join(HERE, '..', 'models.json');
export const USER_CATALOG_PATH = process.env.MIRABILIS_USER_CATALOG
  || path.join(os.homedir(), '.mirabilis', 'models.json');
export const REMOTE_CATALOG_URL = process.env.MIRABILIS_CATALOG_URL
  || 'https://raw.githubusercontent.com/MoshikoNayman/Mirabilis/main/backend/models.json';

/** Refresh at most this often. The list changes weekly at best. */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

/**
 * Same shape the pull route enforces. A malformed id is dropped rather than
 * shown, so a typo upstream cannot put an uninstallable row in the picker.
 */
const SAFE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,99}$/i;

/** @typedef {{id: string, label: string, group: string, ollamaId?: string, size?: string, uncensored?: boolean, deprecated?: boolean}} CatalogModel */

let bundled = /** @type {CatalogModel[] | null} */ (null);
let bundledDefaults = /** @type {Record<string,string> | null} */ (null);
let remoteDefaults = /** @type {Record<string,string> | null} */ (null);
let remoteModels = /** @type {CatalogModel[] | null} */ (null);
let userModels = /** @type {CatalogModel[] | null} */ (null);
let lastFetchAt = 0;
let etag = '';
let inFlight = /** @type {Promise<void> | null} */ (null);

/** Keep only entries that are complete and safe to offer. */
function sanitize(models) {
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of models) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim();
    const ollamaId = String(raw.ollamaId || id).trim();
    if (!id || !SAFE_MODEL_ID.test(id) || !SAFE_MODEL_ID.test(ollamaId)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = { id, label: String(raw.label || id).slice(0, 120), group: String(raw.group || 'Models').slice(0, 60), ollamaId };
    if (raw.size) entry.size = String(raw.size).slice(0, 30);
    if (raw.uncensored === true) entry.uncensored = true;
    if (raw.deprecated === true) entry.deprecated = true;
    out.push(entry);
  }
  return out;
}

function parseCatalog(text) {
  const parsed = JSON.parse(text);
  return sanitize(parsed?.ollama || parsed?.models || parsed);
}

/** Cloud fallbacks, read from the same file so they update the same way. */
function parseDefaults(text) {
  try {
    const parsed = JSON.parse(text);
    const raw = parsed?.providerDefaults;
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const [provider, id] of Object.entries(raw)) {
      if (provider.startsWith('_')) continue; // comment keys
      if (typeof id === 'string' && SAFE_MODEL_ID.test(id)) out[provider] = id;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * The bundled list, read synchronously the first time it is needed.
 *
 * Synchronous on purpose: it is a small file that ships with the app, and every
 * caller wants an answer immediately. Making the catalog async would put a
 * network round trip in front of opening the model picker for no benefit.
 */
function loadBundled() {
  if (bundled) return bundled;
  try {
    const text = readFileSync(BUNDLED_CATALOG_PATH, 'utf8');
    bundled = parseCatalog(text);
    bundledDefaults = parseDefaults(text);
  } catch {
    bundled = []; // packaging accident: the app still runs on discovered models
  }
  return bundled;
}

/** Merge by id, later sources overriding earlier ones. */
function merge(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const model of list || []) byId.set(model.id, { ...byId.get(model.id), ...model });
  }
  return [...byId.values()];
}

/**
 * The current catalog. Never blocks, never throws.
 * @returns {CatalogModel[]}
 */
export function getModels() {
  return merge(loadBundled(), remoteModels, userModels);
}

/**
 * The last-resort model for a cloud provider whose live listing failed.
 *
 * These live in models.json rather than in code for the same reason the catalog
 * does: when a provider ships a new flagship, the old id here is what a user
 * silently gets, and that should not require an app release to correct.
 *
 * @param {string} provider
 * @returns {string} the id, or '' when there is nothing sensible to offer
 */
export function getProviderDefault(provider) {
  loadBundled();
  return (remoteDefaults?.[provider]) || (bundledDefaults?.[provider]) || '';
}

/** Which sources contributed to the list right now. */
export function getSources() {
  const sources = ['bundled'];
  if (remoteModels?.length) sources.push('remote');
  if (userModels?.length) sources.push('user');
  return sources;
}

/**
 * Refresh the remote and user copies in the background.
 *
 * Fire and forget: callers never await this. The updated list is picked up by
 * the next getModels(), so nothing waits on the network for a list we already
 * have a perfectly good copy of.
 *
 * @param {{ localOnly?: boolean, force?: boolean }} [opts]
 */
export async function refreshCatalog({ localOnly = false, force = false } = {}) {
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastFetchAt < REFRESH_INTERVAL_MS) return;

  inFlight = (async () => {
    // The user file is local, so it is read even under Go Dark.
    try {
      const text = await fs.readFile(USER_CATALOG_PATH, 'utf8');
      const parsed = parseCatalog(text);
      userModels = parsed.length > 0 ? parsed : null;
    } catch {
      userModels = null; // absent is the normal case
    }

    // Go Dark means nothing leaves the machine, and a catalog refresh is egress
    // like any other. The bundled list is complete, so this costs nothing.
    if (localOnly) { lastFetchAt = Date.now(); return; }

    try {
      const headers = { Accept: 'application/json' };
      if (etag) headers['If-None-Match'] = etag;
      const res = await fetch(REMOTE_CATALOG_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      lastFetchAt = Date.now();
      if (res.status === 304) return;
      if (!res.ok) return;
      const text = await res.text();
      const models = parseCatalog(text);
      // An empty or unparseable remote list must never blank the picker.
      if (models.length === 0) return;
      remoteModels = models;
      remoteDefaults = parseDefaults(text);
      etag = res.headers.get('etag') || '';
    } catch {
      // Offline, slow, blocked, rate limited: the bundled list stands.
      lastFetchAt = Date.now();
    }
  })().finally(() => { inFlight = null; });

  return inFlight;
}

/** Test seam: drop all cached state. */
export function resetCatalogCache() {
  bundled = null;
  bundledDefaults = null;
  remoteDefaults = null;
  remoteModels = null;
  userModels = null;
  lastFetchAt = 0;
  etag = '';
  inFlight = null;
}
