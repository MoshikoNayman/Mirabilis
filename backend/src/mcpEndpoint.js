// @ts-check
// The on/off switch for Mirabilis's own MCP server (POST /mcp), saved in
// mcp-endpoint.json in the data folder. Missing or unreadable means on.

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { hardenFile, SECURE_DIR_MODE, SECURE_FILE_MODE } from './storage/securePaths.js';

export const MCP_ENDPOINT_FILE = 'mcp-endpoint.json';

/** @typedef {{enabled: boolean, updatedAt: string|null}} McpEndpointState */

/** A bad change; the router answers 400 with the message. */
export class McpEndpointError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'McpEndpointError';
    this.status = 400;
  }
}

/**
 * Whatever is on disk: only an explicit false turns the server off.
 * @param {any} raw
 * @returns {McpEndpointState}
 */
function normalizeState(raw) {
  return {
    enabled: raw?.enabled !== false,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null
  };
}

/** @param {string} dataDir */
export function createMcpEndpointStore(dataDir) {
  const file = path.join(dataDir, MCP_ENDPOINT_FILE);
  /** @type {McpEndpointState} */
  let state = { enabled: true, updatedAt: null };
  let version = 0;
  /** Writes in order, so the file always ends at the latest change. */
  let writes = Promise.resolve();

  /** @returns {McpEndpointState} */
  const get = () => ({ enabled: state.enabled, updatedAt: state.updatedAt });

  /** Temp file then rename, so a crash mid-write keeps the previous setting. @param {McpEndpointState} snapshot */
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

    /** Read mcp-endpoint.json. Missing or unreadable means on, as before the switch existed. */
    async load() {
      try {
        state = normalizeState(JSON.parse(await readFile(file, 'utf8')));
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          console.warn(`[mcp-endpoint] ${file} could not be read (${err?.message || err}); the MCP server stays on.`);
        }
        state = { enabled: true, updatedAt: null };
      }
      return get();
    },

    get,

    isEnabled: () => state.enabled,

    /**
     * Turn the server on or off and save it. Throws McpEndpointError for a bad
     * body; a failed save leaves the previous setting in force.
     * @param {any} patch  {enabled: boolean}
     * @returns {Promise<McpEndpointState>}
     */
    async set(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || typeof patch.enabled !== 'boolean') {
        throw new McpEndpointError('enabled must be true or false.');
      }
      const previous = state;
      version += 1;
      const mine = version;
      state = { enabled: patch.enabled, updatedAt: new Date().toISOString() };
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
    }
  };
  return store;
}
