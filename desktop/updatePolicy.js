'use strict';
// desktop/updatePolicy.js
// When may Mirabilis talk to the update server, and what may it do with the answer?
//
// This is deliberately separate from the Electron glue so it can be tested
// without booting a browser process. Every rule here is a decision that would
// otherwise be buried in a callback and impossible to assert on.
//
// The rule that matters most: Go Dark promises that nothing leaves the machine.
// That promise is enforced in the renderer and the backend send path, and the
// Electron main process is outside both. An update check started from main is
// egress that Go Dark cannot see, so a naive "check on launch" would quietly
// break the one guarantee the product makes. The check therefore FAILS CLOSED:
// it does not run until the renderer has told us the lockdown is off. Not
// knowing is treated exactly like being locked down.

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
  // A dev build has no published counterpart, and electron-updater throws
  // rather than no-oping, so this is a guard and not a nicety.
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
 * What may we do with an update once we know about it?
 *
 * macOS refuses to install an update over an unsigned app: Squirrel.Mac
 * validates the code signature of the running bundle and fails the swap. Until
 * the app is signed and notarized, the only honest option on macOS is to tell
 * the user and send them to the download page. Pretending otherwise produces a
 * download that fails at the last step, which is worse than not offering it.
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
