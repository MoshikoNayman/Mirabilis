// @ts-check
import os from 'node:os';
import path from 'node:path';

/**
 * Expand a leading ~ to the home directory. Paths typed into the UI use it;
 * Node's fs and path.resolve do not understand it.
 * @param {string} input
 */
export function expandHome(input) {
  const s = String(input ?? '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** Resolve a user-typed path: ~ expanded, then made absolute. */
export function resolveUserPath(input) {
  return path.resolve(expandHome(input));
}
