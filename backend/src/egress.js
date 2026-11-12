// @ts-check
// Go Dark: while on, the guarded fetch refuses any host outside this machine or LAN.
// State lives in the data directory so every route, worker and MCP client agrees.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isLocalHostUrl } from './security.js';

export const GO_DARK_FILE = 'go-dark.json';

let goDark = false;
let stateFile = '';
let installed = false;

export class EgressBlockedError extends Error {
  /** @param {string} host */
  constructor(host) {
    super(`Go Dark is on, so Mirabilis did not contact ${host}. Turn Go Dark off to use it.`);
    this.name = 'EgressBlockedError';
    this.code = 'GO_DARK';
    this.host = host;
  }
}

export function isGoDark() {
  return goDark;
}

/** @param {unknown} input */
function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) return String(input.url);
  return String(input);
}

function hostOf(url) {
  try { return new URL(url).host || url; } catch { return url; }
}

/** True when a request to this URL may go out right now. */
export function egressAllowed(url) {
  return !goDark || isLocalHostUrl(url);
}

/**
 * The same classification for a bare host name or address, as tools such as ping
 * receive it: true for this machine and the LAN.
 * @param {string} host
 */
export function isLocalHost(host) {
  const h = String(host ?? '').trim().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (!h || /[\s/@?#\\[\]]/.test(h)) return false;
  return isLocalHostUrl(`http://${h.includes(':') ? `[${h}]` : h}`);
}

/**
 * Go Dark as saved in a data folder, read fresh on every call. For processes that do
 * not share this module's state, such as the built-in machine server.
 * @param {string} dataDir
 */
export async function readGoDark(dataDir) {
  if (!dataDir) return false;
  try {
    return JSON.parse(await readFile(path.join(dataDir, GO_DARK_FILE), 'utf8'))?.on === true;
  } catch {
    return false;
  }
}

/** Throw the standard refusal when Go Dark blocks this URL. */
export function assertEgressAllowed(url) {
  if (!egressAllowed(url)) throw new EgressBlockedError(hostOf(url));
}

/** Wrap global fetch once. Every module that calls fetch goes through this. */
export function installEgressGuard() {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch;
  globalThis.fetch = async function guardedFetch(input, init) {
    assertEgressAllowed(urlOf(input));
    return original(input, init);
  };
}

/** @param {string} dataDir */
export async function loadGoDark(dataDir) {
  stateFile = path.join(dataDir, GO_DARK_FILE);
  goDark = await readGoDark(dataDir);
  return goDark;
}

/** @param {boolean} on */
export async function setGoDark(on) {
  goDark = on === true;
  if (!stateFile) return goDark;
  await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const tmp = `${stateFile}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify({ on: goDark, changedAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(tmp, stateFile);
  return goDark;
}
