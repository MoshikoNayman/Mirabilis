// @ts-check
// Go Dark, enforced in the backend.
//
// The state lives in the data directory so every route, worker and MCP client
// sees the same answer. While it is on, fetch() refuses any host that is not
// this machine or the local network.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isLocalHostUrl } from './security.js';

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
  stateFile = path.join(dataDir, 'go-dark.json');
  try {
    goDark = JSON.parse(await readFile(stateFile, 'utf8'))?.on === true;
  } catch {
    goDark = false;
  }
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
