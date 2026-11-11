// @ts-check
// The Access level and the always-allowed commands, saved in access.json in the data
// folder. One setting for the whole app: a run may lower it, never raise it.

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ACCESS_LEVELS, normalizeLevel } from './agent/permissions.js';
import { hardenFile, SECURE_DIR_MODE, SECURE_FILE_MODE } from './storage/securePaths.js';

export const ACCESS_FILE = 'access.json';
export const MAX_ALLOW_COMMANDS = 200;
export const MAX_RULE_CHARS = 120;

/** @typedef {'chat'|'read'|'ask'|'bypass'} AccessLevel */
/** @typedef {{level: AccessLevel, allowCommands: string[], updatedAt: string|null}} AccessState */

/** A bad settings change; the router answers 400 with the message. */
export class AccessSettingsError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'AccessSettingsError';
    this.status = 400;
  }
}

/** One spacing, so "git  status" and "git status" are the same rule. @param {string} rule */
const tidy = (rule) => rule.trim().replace(/\s+/g, ' ');

/**
 * Check a change to the settings. Returns only the fields that were sent.
 * @param {any} patch
 * @returns {{level?: AccessLevel, allowCommands?: string[]}}
 */
export function validateAccessPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new AccessSettingsError('Send the Access settings as a JSON object.');
  }
  /** @type {{level?: AccessLevel, allowCommands?: string[]}} */
  const out = {};
  if (patch.level !== undefined) {
    if (!ACCESS_LEVELS.includes(patch.level)) {
      throw new AccessSettingsError(`level must be one of: ${ACCESS_LEVELS.join(', ')}.`);
    }
    out.level = patch.level;
  }
  if (patch.allowCommands !== undefined) {
    if (!Array.isArray(patch.allowCommands)) {
      throw new AccessSettingsError('allowCommands must be a list of commands.');
    }
    /** @type {string[]} */
    const list = [];
    for (const item of patch.allowCommands) {
      if (typeof item !== 'string') throw new AccessSettingsError('Each allowed command must be text.');
      const rule = tidy(item);
      if (!rule || rule.length > MAX_RULE_CHARS) {
        throw new AccessSettingsError(`Each allowed command must be 1 to ${MAX_RULE_CHARS} characters.`);
      }
      if (!list.includes(rule)) list.push(rule);
    }
    if (list.length > MAX_ALLOW_COMMANDS) {
      throw new AccessSettingsError(`You can keep up to ${MAX_ALLOW_COMMANDS} allowed commands.`);
    }
    out.allowCommands = list;
  }
  return out;
}

/**
 * Whatever is on disk, made safe: an unknown level reads as Chat only.
 * @param {any} raw
 * @returns {AccessState}
 */
function normalizeState(raw) {
  const list = Array.isArray(raw?.allowCommands)
    ? raw.allowCommands
      .filter((/** @type {unknown} */ s) => typeof s === 'string')
      .map((/** @type {string} */ s) => tidy(s))
      .filter((/** @type {string} */ s) => s && s.length <= MAX_RULE_CHARS)
    : [];
  return {
    level: normalizeLevel(raw?.level),
    allowCommands: [...new Set(list)].slice(0, MAX_ALLOW_COMMANDS),
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null
  };
}

/** @param {string} dataDir */
export function createAccessStore(dataDir) {
  const file = path.join(dataDir, ACCESS_FILE);
  /** @type {AccessState} */
  let state = { level: 'chat', allowCommands: [], updatedAt: null };
  let version = 0;
  /** Writes in order, so the file always ends at the latest change. */
  let writes = Promise.resolve();

  /** @returns {AccessState} */
  const get = () => ({ level: state.level, allowCommands: [...state.allowCommands], updatedAt: state.updatedAt });

  /** Temp file then rename, so a crash mid-write keeps the previous settings. @param {AccessState} snapshot */
  async function persist(snapshot) {
    await mkdir(dataDir, { recursive: true, mode: SECURE_DIR_MODE });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: SECURE_FILE_MODE });
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    await hardenFile(file);
  }

  const store = {
    file,

    /** Read access.json. Missing or unreadable means Chat only, the safe default. */
    async load() {
      try {
        state = normalizeState(JSON.parse(await readFile(file, 'utf8')));
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          console.warn(`[access] ${file} could not be read (${err?.message || err}); using Chat only.`);
        }
        state = { level: 'chat', allowCommands: [], updatedAt: null };
      }
      return get();
    },

    get,

    /**
     * Apply a change and save it. Throws AccessSettingsError for a bad change; a
     * failed save leaves the previous settings in force.
     * @param {any} patch
     * @returns {Promise<AccessState>}
     */
    async set(patch) {
      const clean = validateAccessPatch(patch);
      const previous = state;
      version += 1;
      const mine = version;
      state = { ...state, ...clean, updatedAt: new Date().toISOString() };
      const snapshot = get();
      const next = writes.then(() => persist(snapshot));
      writes = next.catch(() => {});
      try {
        await next;
      } catch (err) {
        if (version === mine) state = previous;
        throw err;
      }
      return snapshot;
    },

    /** Add one rule from an "Always allow" click; the oldest rule goes when the list is full. @param {string} rule */
    async addAllowCommand(rule) {
      const clean = tidy(String(rule || ''));
      if (!clean || clean.length > MAX_RULE_CHARS) return get();
      if (state.allowCommands.includes(clean)) return get();
      return store.set({ allowCommands: [...state.allowCommands, clean].slice(-MAX_ALLOW_COMMANDS) });
    }
  };
  return store;
}
