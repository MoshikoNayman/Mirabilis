// Checks each catalog model against the Ollama registry; exits 1 when one is gone.
// Entries marked "local": true are built on the user's machine and skipped.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(ROOT, 'backend', 'models.json');
const REGISTRY = 'https://registry.ollama.ai/v2/library';
const MANIFEST_ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json';

/** @returns {Promise<number>} HTTP status, or 0 when unreachable */
async function manifestStatus(modelId) {
  const [name, tag = 'latest'] = String(modelId).split(':');
  try {
    const res = await fetch(`${REGISTRY}/${encodeURIComponent(name)}/manifests/${encodeURIComponent(tag)}`, {
      headers: { Accept: MANIFEST_ACCEPT },
      signal: AbortSignal.timeout(15000)
    });
    return res.status;
  } catch {
    return 0;
  }
}

const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
const entries = catalog.ollama || [];

const missing = [];
const unreachable = [];
let checked = 0;
let skipped = 0;

for (const entry of entries) {
  if (entry.local) { skipped += 1; continue; }
  const pullId = entry.ollamaId || entry.id;
  const status = await manifestStatus(pullId);
  checked += 1;
  if (status === 200) continue;
  // Unreachable is not missing: a flaky network must not get a good entry removed.
  if (status === 0) unreachable.push({ pullId, label: entry.label });
  else missing.push({ pullId, label: entry.label, status });
}

console.log(`Catalog check: ${checked} suggested model(s) verified against the registry, ${skipped} locally built and skipped.\n`);

if (unreachable.length > 0) {
  console.log('Could not reach the registry for:');
  for (const u of unreachable) console.log(`  ?  ${u.pullId} (${u.label})`);
  console.log('');
}

if (missing.length > 0) {
  console.error('These suggested models are GONE from the registry, so installing them fails:');
  for (const m of missing) console.error(`  x  ${m.pullId} (${m.label}) - HTTP ${m.status}`);
  console.error(`\nFix backend/models.json: remove the entry, or mark it "deprecated": true.`);
  console.error('That file is read at runtime, so a fix reaches every install without an app release.');
  process.exit(1);
}

if (unreachable.length > 0) {
  console.log('No missing models. Some entries could not be checked (see above); not failing on that.');
} else {
  console.log('Every suggested model still exists upstream.');
}
