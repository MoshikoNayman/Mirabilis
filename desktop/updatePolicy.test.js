'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compareVersions, shouldCheck, installMode, shouldNotify, MIN_CHECK_INTERVAL_MS } = require('./updatePolicy.js');

const base = { isPackaged: true, localOnly: false, enabled: true, now: 1_000_000_000 };

// -- the Go Dark guarantee ---------------------------------------------------

test('no update check runs while Go Dark is on', () => {
  const { check, reason } = shouldCheck({ ...base, localOnly: true });
  assert.equal(check, false);
  assert.match(reason, /Go Dark/);
});

test('no update check runs before the lockdown state is known', () => {
  // Go Dark is unknown until the renderer reports it; unknown counts as locked.
  const { check, reason } = shouldCheck({ ...base, localOnly: null });
  assert.equal(check, false);
  assert.match(reason, /waiting/);
});

test('a check runs once the renderer confirms Go Dark is off', () => {
  assert.equal(shouldCheck(base).check, true);
});

// -- the other gates ---------------------------------------------------------

test('a development build never checks', () => {
  // electron-updater throws rather than no-oping when unpackaged.
  assert.equal(shouldCheck({ ...base, isPackaged: false }).check, false);
});

test('the user preference is honoured', () => {
  assert.equal(shouldCheck({ ...base, enabled: false }).check, false);
});

test('checks are rate limited, and resume after the interval', () => {
  const lastCheckAt = base.now - 1000;
  assert.equal(shouldCheck({ ...base, lastCheckAt }).check, false);
  assert.equal(shouldCheck({ ...base, lastCheckAt: base.now - MIN_CHECK_INTERVAL_MS - 1 }).check, true);
});

test('Go Dark outranks a due check', () => {
  // Lockdown is checked before the interval, so a stale lastCheckAt cannot pass it.
  assert.equal(shouldCheck({ ...base, localOnly: true, lastCheckAt: 0 }).check, false);
});

// -- what we may do with an update -------------------------------------------

test('an unsigned macOS build is never offered a self install', () => {
  // Squirrel.Mac rejects an unsigned bundle, so send the user to the download page.
  assert.equal(installMode('darwin', false), 'manual');
});

test('a signed macOS build installs itself', () => {
  assert.equal(installMode('darwin', true), 'self-install');
});

test('Windows and Linux install themselves even unsigned', () => {
  assert.equal(installMode('win32', false), 'self-install');
  assert.equal(installMode('linux', false), 'self-install');
});

// -- version comparison ------------------------------------------------------

test('a newer version notifies, the same or older does not', () => {
  assert.equal(shouldNotify({ available: '26.4.0', current: '26.3.1' }).notify, true);
  assert.equal(shouldNotify({ available: '26.3.1', current: '26.3.1' }).notify, false);
  assert.equal(shouldNotify({ available: '26.3.0', current: '26.3.1' }).notify, false);
});

test('skipping one version does not silence later ones', () => {
  // Skip stores a version; a boolean would mute every future release.
  assert.equal(shouldNotify({ available: '26.3.2', current: '26.3.1', skipped: '26.3.2' }).notify, false);
  assert.equal(shouldNotify({ available: '26.4.0', current: '26.3.1', skipped: '26.3.2' }).notify, true);
});

test('an empty or missing offer is not a notification', () => {
  assert.equal(shouldNotify({ available: '', current: '26.3.1' }).notify, false);
  assert.equal(shouldNotify({ available: undefined, current: '26.3.1' }).notify, false);
});

test('version comparison handles unequal lengths and a v prefix', () => {
  assert.ok(compareVersions('26.4', '26.3.9') > 0);
  assert.equal(compareVersions('26.3', '26.3.0'), 0);
  assert.ok(compareVersions('v26.4.0', '26.3.1') > 0);
  assert.ok(compareVersions('26.10.0', '26.9.0') > 0, 'numeric, not lexicographic');
});

test('garbage versions never read as an upgrade', () => {
  assert.equal(shouldNotify({ available: 'not-a-version', current: '26.3.1' }).notify, false);
});
