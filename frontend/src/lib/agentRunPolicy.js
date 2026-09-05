// Rules around the autonomous run's tool policy.
//
// These live outside ChatApp.jsx so they can be tested. The bug that created
// this file was not in any single piece of logic; it was in the seam between
// two of them, which is exactly the kind of thing that is invisible until it is
// written down as a function with a name.
//
// What happened: the chosen policy is persisted to localStorage, and the
// acknowledgement required for `full` is deliberately NOT persisted, because
// handing a background process a shell should be a decision you make each
// session rather than one a setting quietly remembers from last week. Both
// halves are defensible. Together they meant that picking `full` once wrote
// "full" to localStorage permanently, and every later session restored a policy
// whose acknowledgement had reset to false. The backend then refused every
// single run, and nothing in the UI could clear it, because the stored value
// was reapplied on each load. One choice, weeks earlier, bricked the feature.

export const TOOL_POLICIES = ['read-only', 'write', 'full'];

/** The policy to fall back to when a stored one cannot be honoured. */
export const SAFE_POLICY = 'write';

export const DEFAULT_POLICY = 'read-only';

/**
 * Turn a persisted policy into one that is safe to start a session with.
 *
 * `full` never survives a reload. The acknowledgement that makes it usable is
 * per session by design, so restoring `full` produces a policy the backend
 * rejects on every run. Downgrading is both the safe answer and the only one
 * that cannot deadlock.
 *
 * @param {unknown} saved value read back from storage
 * @returns {'read-only'|'write'|'full'}
 */
export function restoreToolPolicy(saved) {
  if (typeof saved !== 'string' || !TOOL_POLICIES.includes(saved)) return DEFAULT_POLICY;
  if (saved === 'full') return SAFE_POLICY;
  return /** @type {'read-only'|'write'} */ (saved);
}

/**
 * Does this run need the user to acknowledge the shell policy before it starts?
 *
 * Asking is always better than the alternative, which is a request the server
 * refuses and an error the user cannot act on.
 *
 * @param {string} policy
 * @param {boolean} acknowledged
 */
export function needsFullAcknowledgement(policy, acknowledged) {
  return policy === 'full' && acknowledged !== true;
}

/**
 * Turn a failed run response into something a person can read.
 *
 * The previous behaviour was to print the raw response body, so a refusal
 * arrived on screen as a wall of JSON with escaped quotes. The server already
 * writes a plain sentence in `error`; use it.
 *
 * @param {number} status
 * @param {string} body raw response text
 * @returns {string}
 */
export function describeRunError(status, body) {
  const raw = typeof body === 'string' ? body.trim() : '';
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
        return parsed.error.trim();
      }
    } catch {
      // Not JSON: fall through and use the text, which beats showing nothing.
    }
    // Only surface a raw body when it is short enough to be a message rather
    // than a payload dump.
    if (!raw.startsWith('{') && !raw.startsWith('[') && raw.length <= 300) return raw;
  }
  return `The run could not be started (${status}).`;
}
