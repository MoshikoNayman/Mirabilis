'use strict';
// Update-check rules, kept out of the Electron glue so they can be tested.
// Main-process egress bypasses Go Dark, so checks wait until the renderer reports it off.

/** Do not re-check more than once every six hours. */
const MIN_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * @param {string} version
 * @returns {number[]} numeric components, missing ones read as 0
 */
function parts(version) {
  return String(version || '')
    .trim()
    .replace(/^v/, '')
    .split(/[.\-+]/)
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => Number.isFinite(n));
}

/** @returns {number} negative if a < b, 0 if equal, positive if a > b */
function compareVersions(a, b) {
  const left = parts(a);
  const right = parts(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * May we contact the update server right now?
 *
 * @param {object} input
 * @param {boolean} input.isPackaged        false in `npm run dev`
 * @param {boolean|null} input.localOnly    Go Dark, or null if not yet reported
 * @param {boolean} input.enabled           the user's preference
 * @param {number} input.now
 * @param {number} [input.lastCheckAt]
 * @param {number} [input.minIntervalMs]
 * @returns {{ check: boolean, reason: string }}
 */
function shouldCheck({ isPackaged, localOnly, enabled, now, lastCheckAt = 0, minIntervalMs = MIN_CHECK_INTERVAL_MS }) {
  // Dev builds have no published release, and electron-updater throws on them.
  if (!isPackaged) return { check: false, reason: 'development build' };
  if (enabled === false) return { check: false, reason: 'update checks are turned off' };
  // Fail closed. Unknown lockdown state is treated as locked down.
  if (localOnly !== false) {
    return {
      check: false,
      reason: localOnly === null ? 'waiting for the Go Dark state' : 'Go Dark is on'
    };
  }
  if (now - lastCheckAt < minIntervalMs) return { check: false, reason: 'checked recently' };
  return { check: true, reason: 'ok' };
}

/**
 * How an available update may be applied. Squirrel.Mac rejects an update over
 * an unsigned bundle, so unsigned macOS builds go to the download page.
 *
 * @param {string} platform  process.platform
 * @param {boolean} signed   whether this build is code signed
 * @returns {'self-install'|'manual'}
 */
function installMode(platform, signed) {
  if (platform === 'darwin' && !signed) return 'manual';
  return 'self-install';
}

/**
 * Is this a version worth interrupting the user about?
 *
 * @param {object} input
 * @param {string} input.available
 * @param {string} input.current
 * @param {string} [input.skipped]  a version the user asked not to hear about again
 * @returns {{ notify: boolean, reason: string }}
 */
function shouldNotify({ available, current, skipped = '' }) {
  if (!available) return { notify: false, reason: 'no version offered' };
  if (compareVersions(available, current) <= 0) return { notify: false, reason: 'not newer' };
  // Skipping 26.3.2 must not also silence 26.4.0.
  if (skipped && compareVersions(available, skipped) <= 0) return { notify: false, reason: 'skipped by the user' };
  return { notify: true, reason: 'newer version available' };
}

module.exports = {
  MIN_CHECK_INTERVAL_MS,
  compareVersions,
  shouldCheck,
  installMode,
  shouldNotify
};
