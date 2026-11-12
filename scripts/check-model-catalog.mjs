// Checks each catalog model against the Ollama registry; exits 1 when one is gone.
// Entries marked "local": true are built on the user's machine and skipped.
// Then a parser canary: Settings > Models reads ollama.com's HTML, which has no
// API and no stability promise, so one search page and one tags page must still
// parse. Exits 1 when they come back empty or malformed.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOllamaLibrary, LibraryError } from '../backend/src/ollamaLibrary.js';

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
let failed = false;

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
  console.error('That file is read at runtime, so a fix reaches every install without an app release.\n');
  failed = true;
} else if (unreachable.length > 0) {
  console.log('No missing models. Some entries could not be checked (see above); not failing on that.\n');
} else {
  console.log('Every suggested model still exists upstream.\n');
}

// Parser canary. No model names of its own: the popular listing, and the tags of
// the first catalog model, which the check above just verified.
const library = createOllamaLibrary();
const family = String(entries.find((e) => !e.local)?.ollamaId || entries.find((e) => !e.local)?.id || 'qwen3').split(':')[0];
const broken = [];
const offline = [];

/** @param {string} what @param {any} err */
function record(what, err) {
  // Unreachable is not broken, for the same reason as above.
  if (err instanceof LibraryError && err.kind === 'unreachable') offline.push(what);
  else broken.push(`${what}: ${err?.message || err}`);
}

try {
  const page = await library.search({});
  const results = page.results;
  if (results.length < 10) broken.push(`the popular search page parsed to ${results.length} model(s); it lists 20`);
  if (!results.some((r) => r.capabilities.length > 0)) broken.push('no search result has capabilities (tools, vision, ...): the chip markup changed');
  if (!results.some((r) => r.sizes.length > 0)) broken.push('no search result has sizes (8b, 27b, ...): the chip markup changed');
  if (!results.some((r) => typeof r.pulls === 'number')) broken.push('no search result has a download count');
  if (!results.some((r) => r.updated)) broken.push('no search result has an updated date');
  if (!page.hasMore) broken.push('the search page shows no next page: the infinite-scroll marker changed');
  if (results.length > 0) console.log(`Parser canary: search parsed ${results.length} models (${results.slice(0, 5).map((r) => r.name).join(', ')}, ...).`);
  if (page.hasMore) {
    // More in the pane is page 2; the site sends anything but its own scroll back to page 1.
    const next = await library.search({ page: 2 });
    const seen = new Set(results.map((r) => r.name));
    const fresh = next.results.filter((r) => !seen.has(r.name)).length;
    if (fresh < 5) broken.push(`search page 2 brought ${fresh} new model(s): paging changed`);
    else console.log(`Parser canary: search page 2 parsed ${next.results.length} models, ${fresh} new.`);
  }
} catch (err) {
  record('search page', err);
}

try {
  const { tags } = await library.tags(family);
  if (tags.length === 0) broken.push(`the tags page of ${family} parsed to no installable tags`);
  if (!tags.every((t) => t.name.startsWith(`${family}:`))) broken.push(`a tag of ${family} parsed to a foreign name`);
  if (!tags.some((t) => Number(t.sizeBytes) > 0)) broken.push(`no tag of ${family} has a size`);
  if (!tags.some((t) => Number(t.context) > 0)) broken.push(`no tag of ${family} has a context window`);
  if (!tags.some((t) => t.digest)) broken.push(`no tag of ${family} has a digest; update checks rely on it`);
  if (tags.length > 0) console.log(`Parser canary: ${family} parsed ${tags.length} tags (${tags.slice(0, 4).map((t) => `${t.tag} ${t.size}`).join(', ')}, ...).`);
} catch (err) {
  record(`tags page of ${family}`, err);
}

if (offline.length > 0) console.log(`Could not reach ollama.com for: ${offline.join(', ')}; not failing on that.`);
if (broken.length > 0) {
  console.error('\nollama.com changed its pages, so Settings > Models cannot read them:');
  for (const b of broken) console.error(`  x  ${b}`);
  console.error('\nFix the parser in backend/src/ollamaLibrary.js and refresh its fixtures in');
  console.error('backend/src/testdata/ollama from the live pages. Until then the Models pane cannot');
  console.error('search the library; installing a model by name still works.');
  failed = true;
} else if (offline.length === 0) {
  console.log('Parser canary: ollama.com search and tags pages still parse.');
}

if (failed) process.exit(1);
