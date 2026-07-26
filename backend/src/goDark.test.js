// Go Dark (local-only lockdown) tests.
//
// Go Dark is a promise: with it on, nothing leaves the machine. That promise was
// enforced by a single unguarded line testing the provider ID against a set,
// which is wrong in both directions. openai-compatible, vllm and llamacpp all
// take an arbitrary base URL, so they were waved through even when pointed at a
// cloud endpoint.
//
// These import the real classification from providerScope.js, the same module
// the send path uses, so drift in the server is caught here. The completeness
// test has teeth: adding a provider without classifying it fails the build
// rather than silently defaulting to "allowed under Go Dark".

import test from 'node:test';
import assert from 'node:assert/strict';

import { isLocalHostUrl } from './security.js';
import {
  ALL_PROVIDERS, REMOTE_PROVIDERS, BASE_URL_PROVIDERS, LOCAL_PROVIDERS,
  classifyProviderScope, defaultBaseUrlForProvider
} from './providerScope.js';

test('every provider is classified, with no unclassified remainder', () => {
  const unclassified = ALL_PROVIDERS.filter(
    (p) => !REMOTE_PROVIDERS.has(p) && !BASE_URL_PROVIDERS.has(p) && !LOCAL_PROVIDERS.has(p)
  );
  assert.deepEqual(
    unclassified, [],
    'Adding a provider without classifying it would let Go Dark wave it through. ' +
    'Classify it as remote, base-url-dependent, or local.'
  );
});

test('the three classifications do not overlap', () => {
  for (const p of ALL_PROVIDERS) {
    const hits = [REMOTE_PROVIDERS.has(p), BASE_URL_PROVIDERS.has(p), LOCAL_PROVIDERS.has(p)].filter(Boolean).length;
    assert.equal(hits, 1, `${p} must belong to exactly one class, found ${hits}`);
  }
});

test('the providers with a user-supplied base URL are exactly the ones needing a host check', () => {
  // Regression guard for the original bug: REMOTE_PROVIDERS omitted these three,
  // which is precisely why Go Dark let them through.
  for (const p of ['openai-compatible', 'vllm', 'llamacpp']) {
    assert.ok(BASE_URL_PROVIDERS.has(p), `${p} takes an arbitrary base URL and must be host-checked`);
    assert.ok(!REMOTE_PROVIDERS.has(p), `${p} is not unconditionally remote`);
  }
});

// ── isLocalHostUrl: the primitive the lockdown now depends on ────────────────

test('isLocalHostUrl accepts loopback and private LAN hosts', () => {
  const local = [
    'http://localhost:11434',
    'http://127.0.0.1:8080/v1',
    'http://127.1.2.3:8080',
    'https://box.local:8443',
    'http://10.0.0.5:8000/v1',
    'http://192.168.1.50:8080',
    'http://172.16.4.9:8000',
    'http://172.31.255.254:8000'
  ];
  for (const url of local) {
    assert.equal(isLocalHostUrl(url), true, `${url} should count as on-device or LAN`);
  }
});

test('isLocalHostUrl rejects public hosts', () => {
  const remote = [
    'https://api.openai.com/v1',
    'https://api.anthropic.com',
    'https://generativelanguage.googleapis.com',
    'http://8.8.8.8:8000',
    'http://172.32.0.1:8000',   // just outside 172.16/12
    'http://172.15.0.1:8000',   // just below 172.16/12
    'http://11.0.0.1:8000',     // just outside 10/8
    'http://192.167.1.1:8000'   // just outside 192.168/16
  ];
  for (const url of remote) {
    assert.equal(isLocalHostUrl(url), false, `${url} must NOT count as local`);
  }
});

test('isLocalHostUrl fails closed on empty or unparseable input', () => {
  // The safe answer must win: an unknown destination is treated as remote, so
  // Go Dark blocks rather than allows.
  for (const bad of ['', '   ', 'not a url', 'ollama.com', null, undefined]) {
    assert.equal(isLocalHostUrl(/** @type {any} */ (bad)), false, `${JSON.stringify(bad)} must fail closed`);
  }
});

test('isLocalHostUrl rejects cloud metadata link-local', () => {
  // 169.254.169.254 is the classic SSRF target and is never a trusted peer.
  assert.equal(isLocalHostUrl('http://169.254.169.254/latest/meta-data/'), false);
});

test('isLocalHostUrl is not fooled by a hostname that merely contains localhost', () => {
  assert.equal(isLocalHostUrl('https://localhost.evil.com/v1'), false);
  assert.equal(isLocalHostUrl('https://notlocalhost/v1'), false);
});

// ── classifyProviderScope: what the send path actually calls ─────────────────

test('cloud providers are blocked under Go Dark regardless of base URL', () => {
  for (const p of REMOTE_PROVIDERS) {
    // Even if someone passes a localhost base URL, a vendor provider is remote.
    const scope = classifyProviderScope(p, 'http://127.0.0.1:1234/v1');
    assert.equal(scope.offDevice, true, `${p} must be blocked under Go Dark`);
  }
});

test('local engines are allowed under Go Dark', () => {
  for (const p of LOCAL_PROVIDERS) {
    assert.equal(classifyProviderScope(p).offDevice, false, `${p} should be allowed`);
  }
});

test('base-URL providers are allowed on localhost and blocked on a cloud host', () => {
  for (const p of BASE_URL_PROVIDERS) {
    assert.equal(
      classifyProviderScope(p, 'http://127.0.0.1:8000/v1').offDevice, false,
      `${p} on loopback should be allowed`
    );
    assert.equal(
      classifyProviderScope(p, 'https://api.openai.com/v1').offDevice, true,
      `${p} pointed at a cloud host must be blocked: this was the original bug`
    );
  }
});

test('base-URL providers with a blank URL fall back to their local default', () => {
  // Leaving the field empty means "the local server on the usual port", which
  // is on-device and must stay usable under Go Dark.
  assert.equal(classifyProviderScope('vllm', '').offDevice, false);
  assert.equal(classifyProviderScope('llamacpp', '   ').offDevice, false);
  assert.ok(isLocalHostUrl(defaultBaseUrlForProvider('vllm')));
  assert.ok(isLocalHostUrl(defaultBaseUrlForProvider('llamacpp')));
  // openai-compatible has no local default, so a blank URL is unknown: fail closed.
  assert.equal(classifyProviderScope('openai-compatible', '').offDevice, true);
});

test('an unknown provider fails closed under Go Dark', () => {
  assert.equal(classifyProviderScope('some-new-provider').offDevice, true);
  assert.equal(classifyProviderScope('').offDevice, true);
});

test('every classification carries a reason the user can act on', () => {
  for (const p of ALL_PROVIDERS) {
    const scope = classifyProviderScope(p, 'https://api.example.com/v1');
    if (scope.offDevice) assert.ok(scope.reason.length > 0, `${p} should explain why it was blocked`);
  }
});
