// Tool policy rules for autonomous runs, kept out of ChatApp.jsx so they are testable.

export const TOOL_POLICIES = ['read-only', 'write', 'full'];

/** The policy to fall back to when a stored one cannot be honoured. */
export const SAFE_POLICY = 'write';

export const DEFAULT_POLICY = 'read-only';

/**
 * Maps a persisted policy to one that is safe to start a session with.
 *
 * `full` is downgraded: its acknowledgement is per session and not persisted,
 * so a restored `full` would be refused by the backend on every run.
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
 * True when the user must acknowledge the shell policy before the run starts.
 *
 * @param {string} policy
 * @param {boolean} acknowledged
 */
export function needsFullAcknowledgement(policy, acknowledged) {
  return policy === 'full' && acknowledged !== true;
}

/**
 * Readable message for a failed run, preferring the server's plain-sentence `error`.
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
      // Not JSON: fall through to the raw text.
    }
    // Show a raw body only when it is short enough to read as a message.
    if (!raw.startsWith('{') && !raw.startsWith('[') && raw.length <= 300) return raw;
  }
  return `The run could not be started (${status}).`;
}
