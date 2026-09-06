// Structural checks on backend/models.json.
//
// This file is fetched at runtime by every install, so a malformed edit stops
// updates for everyone. The loader is defensive and falls back to the bundled
// copy, which means a broken file fails SILENTLY: exactly the kind of error
// that survives for months. Catch it here instead.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(ROOT, 'backend', 'models.json');

// Must match modelCatalog.js and the pull route. An id that fails this is
// dropped at runtime, so the entry would simply never appear.
const SAFE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,99}$/i;

const problems = [];
let catalog;

try {
  catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
} catch (error) {
  console.error(`backend/models.json is not valid JSON: ${error.message}`);
  process.exit(1);
}

const entries = catalog.ollama;
if (!Array.isArray(entries) || entries.length === 0) {
  problems.push('"ollama" must be a non-empty array');
} else {
  const seen = new Map();
  entries.forEach((entry, i) => {
    const where = `ollama[${i}]${entry?.id ? ` (${entry.id})` : ''}`;
    if (!entry || typeof entry !== 'object') { problems.push(`${where}: not an object`); return; }
    for (const field of ['id', 'label', 'group']) {
      if (!entry[field] || typeof entry[field] !== 'string') problems.push(`${where}: "${field}" is required`);
    }
    const pullId = entry.ollamaId || entry.id;
    if (entry.id && !SAFE_MODEL_ID.test(entry.id)) problems.push(`${where}: id would be rejected at runtime`);
    if (pullId && !SAFE_MODEL_ID.test(pullId)) problems.push(`${where}: ollamaId would be rejected at runtime`);
    if (entry.id) {
      if (seen.has(entry.id)) problems.push(`${where}: duplicate id, also at ollama[${seen.get(entry.id)}]`);
      else seen.set(entry.id, i);
    }
  });
}

const defaults = catalog.providerDefaults;
if (defaults !== undefined) {
  if (typeof defaults !== 'object' || defaults === null) {
    problems.push('"providerDefaults" must be an object');
  } else {
    for (const [provider, id] of Object.entries(defaults)) {
      if (provider.startsWith('_')) continue;
      if (typeof id !== 'string' || !SAFE_MODEL_ID.test(id)) {
        problems.push(`providerDefaults.${provider}: "${id}" would be rejected at runtime`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error('backend/models.json has problems:\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nEntries that fail these checks are dropped silently at runtime.');
  process.exit(1);
}

console.log(`backend/models.json is valid: ${entries.length} models, ${Object.keys(defaults || {}).filter((k) => !k.startsWith('_')).length} provider defaults.`);
