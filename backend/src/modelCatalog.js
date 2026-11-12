// @ts-check
// Suggested-model catalog from bundled, remote and user models.json. A remote list at
// least as new as the bundle replaces it; the user file adds and overrides by id.
// Suggestions only: the pull route validates ids itself, and the bundled list covers offline and Go Dark.

import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readBodyCapped } from './ollamaRegistry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const BUNDLED_CATALOG_PATH = path.join(HERE, '..', 'models.json');
export const USER_CATALOG_PATH = process.env.MIRABILIS_USER_CATALOG
  || path.join(os.homedir(), '.mirabilis', 'models.json');
export const REMOTE_CATALOG_URL = process.env.MIRABILIS_CATALOG_URL
  || 'https://raw.githubusercontent.com/MoshikoNayman/Mirabilis/main/backend/models.json';

/** Refresh at most this often. */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;
const MAX_CATALOG_BYTES = 1024 * 1024;

/** Same shape the pull route enforces, so the picker never offers an uninstallable id. */
const SAFE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,99}$/i;

/** @typedef {{id: string, label: string, group: string, ollamaId?: string, size?: string, uncensored?: boolean, local?: boolean, deprecated?: boolean}} CatalogModel */

let bundled = /** @type {CatalogModel[] | null} */ (null);
let bundledDefaults = /** @type {Record<string,string> | null} */ (null);
let bundledUpdated = '';
let remoteUpdated = '';
let remoteDefaults = /** @type {Record<string,string> | null} */ (null);
let remoteModels = /** @type {CatalogModel[] | null} */ (null);
let userModels = /** @type {CatalogModel[] | null} */ (null);
let lastFetchAt = 0;
let etag = '';
let inFlight = /** @type {Promise<void> | null} */ (null);

/**
 * Ollama reports name:tag, and a bare name means name:latest. Catalog rows
 * match installed models on this form.
 * @param {string} name
 * @returns {string}
 */
export function ollamaTag(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  // The tag follows the last slash, so a registry host:port is not one.
  return s.indexOf(':', s.lastIndexOf('/') + 1) === -1 ? `${s}:latest` : s;
}

/** Names that say what the model is, for installs the catalog does not list. */
export const UNCENSORED_NAME_RE = /uncensored|abliterat|heretic|dolphin/i;

/**
 * The catalog row an installed name belongs to: the row of its exact tag, else
 * a row of another tag of the same model, preferring the tag it extends
 * (qwen3.8:27b-mlx is qwen3.8:27b). A new build of a catalog model keeps the
 * catalog's group and flags with no catalog change.
 * @template {{ id: string, ollamaId?: string }} T
 * @param {string} name
 * @param {T[]} rows
 * @returns {{ row: T, exact: boolean } | null}
 */
export function catalogRowFor(name, rows) {
  const key = ollamaTag(name).toLowerCase();
  if (!key) return null;
  const cut = key.lastIndexOf(':');
  const base = key.slice(0, cut);
  const tag = key.slice(cut + 1);
  /** @type {T | null} */
  let sibling = null;
  /** @type {T | null} */
  let extended = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const rowKey = ollamaTag(row?.ollamaId || row?.id).toLowerCase();
    if (rowKey === key) return { row, exact: true };
    const rowCut = rowKey.lastIndexOf(':');
    if (rowCut < 0 || rowKey.slice(0, rowCut) !== base) continue;
    sibling ??= row;
    if (!extended && tag.startsWith(`${rowKey.slice(rowCut + 1)}-`)) extended = row;
  }
  const row = extended || sibling;
  return row ? { row, exact: false } : null;
}

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
    // Built on this machine (MCQ), so the registry knows nothing about it.
    if (raw.local === true) entry.local = true;
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

/** The file's "updated" day (YYYY-MM-DD), or '' when it has none. */
function parseUpdated(text) {
  try {
    const value = JSON.parse(text)?.updated;
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
  } catch {
    return '';
  }
}

/** The bundled list, read synchronously on first use so callers never wait. */
function loadBundled() {
  if (bundled) return bundled;
  try {
    const text = readFileSync(BUNDLED_CATALOG_PATH, 'utf8');
    bundled = parseCatalog(text);
    bundledDefaults = parseDefaults(text);
    bundledUpdated = parseUpdated(text);
  } catch {
    bundled = []; // missing or unreadable bundle: fall back to discovered models
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
 * How the remote list combines with the bundle. Dated lists replace or yield, so a
 * pick dropped on main leaves every install without a release, and a newer app keeps
 * its newer bundle. An undated list only adds and overrides.
 * @returns {'none' | 'replace' | 'ignore' | 'merge'}
 */
function remoteMode() {
  loadBundled();
  if (!remoteModels) return 'none';
  if (!remoteUpdated || !bundledUpdated) return 'merge';
  return remoteUpdated >= bundledUpdated ? 'replace' : 'ignore';
}

/**
 * The current catalog. Never blocks, never throws.
 * @returns {CatalogModel[]}
 */
export function getModels() {
  const mode = remoteMode();
  if (mode === 'replace') return merge(remoteModels, userModels);
  if (mode === 'merge') return merge(loadBundled(), remoteModels, userModels);
  return merge(loadBundled(), userModels);
}

/**
 * Last-resort model for a cloud provider whose live listing failed.
 * Kept in models.json so it can change without an app release.
 * @param {string} provider
 * @returns {string} the id, or '' when there is nothing sensible to offer
 */
export function getProviderDefault(provider) {
  const remote = remoteMode() === 'ignore' ? null : remoteDefaults;
  return (remote?.[provider]) || (bundledDefaults?.[provider]) || '';
}

/** Which sources contributed to the list right now. */
export function getSources() {
  const mode = remoteMode();
  const sources = mode === 'replace' ? [] : ['bundled'];
  if (mode === 'replace' || mode === 'merge') sources.push('remote');
  if (userModels?.length) sources.push('user');
  return sources;
}

/**
 * Refresh the remote and user copies. Fire and forget; the next getModels() sees the result.
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

    // A catalog refresh is egress, so Go Dark skips it.
    if (localOnly) { lastFetchAt = Date.now(); return; }

    try {
      const headers = { Accept: 'application/json' };
      if (etag) headers['If-None-Match'] = etag;
      const res = await fetch(REMOTE_CATALOG_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      lastFetchAt = Date.now();
      if (res.status === 304) return;
      if (!res.ok) return;
      // The file is a few KB; a body far past that is not a catalog.
      const text = (await readBodyCapped(res, MAX_CATALOG_BYTES)).toString('utf8');
      const models = parseCatalog(text);
      // An empty or unparseable remote list must never blank the picker.
      if (models.length === 0) return;
      remoteModels = models;
      remoteDefaults = parseDefaults(text);
      remoteUpdated = parseUpdated(text);
      etag = res.headers.get('etag') || '';
    } catch {
      // Network failure: keep the bundled list.
      lastFetchAt = Date.now();
    }
  })().finally(() => { inFlight = null; });

  return inFlight;
}

/** Test seam: drop all cached state. */
export function resetCatalogCache() {
  bundled = null;
  bundledDefaults = null;
  bundledUpdated = '';
  remoteUpdated = '';
  remoteDefaults = null;
  remoteModels = null;
  userModels = null;
  lastFetchAt = 0;
  etag = '';
  inFlight = null;
}
