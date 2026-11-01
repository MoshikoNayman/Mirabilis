// Go Dark (local-only lockdown) against the same providerScope.js the send path uses.

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
  for (const p of ['openai-compatible', 'vllm', 'llamacpp']) {
    assert.ok(BASE_URL_PROVIDERS.has(p), `${p} takes an arbitrary base URL and must be host-checked`);
    assert.ok(!REMOTE_PROVIDERS.has(p), `${p} is not unconditionally remote`);
  }
});

// isLocalHostUrl

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
  // An unknown destination counts as remote, so Go Dark blocks it.
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

// classifyProviderScope

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
  // A blank URL means the local server on its usual port.
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
