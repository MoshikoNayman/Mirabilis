import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiFetch } from './api.js';
import {
  parseSizeBytes, formatBytes, itemSize, modelFit, fitDetail, fitBucket, FIT_LABELS, formatContext, formatCount,
  formatRate, formatEta, jobProgressText, formatAgo, normalizeModelName, baseModelName, pullName, rowIdForName, isInstalledName,
  exactModelName, sortInstalled, sortTags, primaryTagCount, groupByCatalog, recommendedGroups, installedNameSet,
  updateStatus, isUncensoredModelRecord, isEmbeddingOnly, autoCandidates, pickAutoModel, pickUncensoredModel,
  LARGE_CONTEXT_THRESHOLD, normalizeInstalled, normalizeUpdates, normalizeLibrary, normalizeTags, normalizeJob,
  libraryQuery, fetchInstalled, fetchUpdates, fetchLibrary, fetchLibraryTags, lookupRegistry, listInstallJobs,
  getInstallJob, startInstallJob, cancelInstallJob, deleteInstalledModel, DOWNLOAD_URL, followInstallJob, JOB_LOST
} from './models.js';

// Only the request helper is replaced; API_BASE and the rest of api.js stay real.
vi.mock('./api.js', async (importOriginal) => ({ ...(await importOriginal()), apiFetch: vi.fn() }));

const GB = 1e9;

// A slice of backend/models.json in its order, as GET /api/models?provider=ollama lists it.
const CATALOG = [
  { id: 'mcq-pro-12b', label: 'MCQ-Pro-12B', group: 'MCQ', ollamaId: 'mcq-pro-12b', size: '8.2 GB', local: true },
  { id: 'mcq-raw-8b', label: 'MCQ-Raw-8B', group: 'MCQ', ollamaId: 'mcq-raw-8b', size: '4.9 GB', uncensored: true, local: true },
  { id: 'lfm3:1.7b', label: 'LFM3 1.7B', group: 'Small & Fast', ollamaId: 'lfm3:1.7b', size: '1.1-1.7 GB' },
  { id: 'qwen3.5:9b', label: 'Qwen 3.5 9B', group: 'Small & Fast', ollamaId: 'qwen3.5:9b', size: '6.6-7.6 GB' },
  { id: 'gemma4:e4b', label: 'Gemma 4 E4B', group: 'Small & Fast', ollamaId: 'gemma4:e4b', size: '6.6-9.5 GB' },
  { id: 'gemma4:12b', label: 'Gemma 4 12B', group: 'Powerful', ollamaId: 'gemma4:12b', size: '7.7-8.0 GB' },
  { id: 'qwen3.8:27b', label: 'Qwen 3.8 27B', group: 'Powerful', ollamaId: 'qwen3.8:27b', size: '18 GB' },
  { id: 'rnj-1:8b', label: 'Rnj-1 8B', group: 'Coding', ollamaId: 'rnj-1:8b', size: '5.1 GB' },
  { id: 'nemotron-3-nano:4b', label: 'Nemotron 3 Nano 4B (NVIDIA)', group: 'Reasoning', ollamaId: 'nemotron-3-nano:4b', size: '2.8-2.9 GB' },
  { id: 'glm-ocr', label: 'GLM-OCR (documents)', group: 'Vision', ollamaId: 'glm-ocr', size: '2.7 GB' },
  { id: 'dolphin3', label: 'Dolphin 3.0 8B', group: 'Uncensored', ollamaId: 'dolphin3', size: '4.9 GB', uncensored: true },
  { id: 'hermes3:8b', label: 'Hermes 3 8B', group: 'Uncensored', ollamaId: 'hermes3:8b', size: '4.7 GB', uncensored: true },
  { id: 'dolphin-mixtral', label: 'Dolphin Mixtral 8x7B', group: 'Uncensored', ollamaId: 'dolphin-mixtral:8x7b', size: '26 GB', uncensored: true }
];

/** The picker list with these names installed, plus extras for names the catalog lacks. */
function listWith(installed = {}, extras = []) {
  return [
    ...CATALOG.map((row) => {
      const hit = installed[row.id];
      return { ...row, available: Boolean(hit), sizeBytes: hit?.sizeBytes ?? null, ...(hit || {}) };
    }),
    ...extras.map((e) => ({ label: e.id, group: 'Installed locally', available: true, ...e }))
  ];
}

// This Mac today: qwen3:8b (no longer in the catalog) and dolphin3:latest.
const OWNER = listWith(
  { dolphin3: { sizeBytes: 4920757726, capabilities: ['completion'], contextWindow: 131072 } },
  [{ id: 'qwen3:8b', sizeBytes: 5225388164, capabilities: ['completion', 'tools', 'thinking'], contextWindow: 40960 }]
);

describe('sizes', () => {
  it('reads byte counts and size texts, taking the larger end of a range', () => {
    expect(parseSizeBytes(5225388164)).toBe(5225388164);
    expect(parseSizeBytes('6.6-7.6 GB')).toBe(7.6 * GB);
    expect(parseSizeBytes('6.6 - 7.6 GB')).toBe(7.6 * GB);
    expect(parseSizeBytes('1.1-1.7 GB')).toBe(1.7 * GB);
    expect(parseSizeBytes('815 MB')).toBe(815e6);
    expect(parseSizeBytes('815 MB - 1.2 GB')).toBe(1.2 * GB);
    expect(parseSizeBytes('~20 GB')).toBe(20 * GB);
    expect(parseSizeBytes('18GB')).toBe(18 * GB);
  });

  it('gives null for anything without a size', () => {
    for (const bad of [null, undefined, '', 'big', '20', 0, -5, NaN, {}]) expect(parseSizeBytes(bad), String(bad)).toBeNull();
  });

  it('formats in decimal units like Ollama', () => {
    expect(formatBytes(5225388164)).toBe('5.2 GB');
    expect(formatBytes(18 * GB)).toBe('18 GB');
    expect(formatBytes(9.97 * GB)).toBe('10 GB');
    expect(formatBytes(815e6)).toBe('815 MB');
    expect(formatBytes(1.5e12)).toBe('1.5 TB');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(null)).toBe('');
  });

  it('judges installed rows on their bytes and catalog rows on their size text', () => {
    expect(itemSize({ sizeBytes: 5e9, size: '9 GB' })).toBe(5e9);
    expect(itemSize({ sizeBytes: null, size: '9 GB' })).toBe('9 GB');
    expect(itemSize({ sizeBytes: 0, size: '9 GB' })).toBe('9 GB');
    expect(itemSize(null)).toBeNull();
  });
});

describe('modelFit', () => {
  it('keeps the old thresholds: 1.2x weights within 60% fits, within 82% is tight', () => {
    expect(modelFit(8.0 * GB, 16)).toBe('fits');
    expect(modelFit(8.1 * GB, 16)).toBe('tight');
    expect(modelFit(10.9 * GB, 16)).toBe('tight');
    expect(modelFit(11 * GB, 16)).toBe('swap');
  });

  it('reads catalog size texts by their larger end', () => {
    expect(modelFit('6.6-7.6 GB', 16)).toBe('fits');
    expect(modelFit('6.6-9.5 GB', 16)).toBe('tight');
    expect(modelFit('19-20 GB', 16)).toBe('swap');
    expect(modelFit('19-20 GB', 32)).toBe('tight');
    expect(modelFit('815 MB', 8)).toBe('fits');
  });

  it('says nothing without both numbers', () => {
    expect(modelFit('5 GB', null)).toBeNull();
    expect(modelFit('5 GB', 0)).toBeNull();
    expect(modelFit(null, 16)).toBeNull();
    expect(modelFit('unknown', 16)).toBeNull();
  });

  it('labels and explains each fit', () => {
    expect(FIT_LABELS).toEqual({ fits: 'Fits', tight: 'Tight', swap: 'Will swap' });
    expect(fitDetail('6.6-7.6 GB', 16)).toBe('7.6 GB weights, 16 GB memory');
    expect(fitDetail(null, 16)).toBe('');
  });

  it('maps memory to the library download-size filter', () => {
    expect([8, 16, 16.5, 24, 32, 36, 64, 96, 128].map(fitBucket)).toEqual(['8', '8', '16', '16', '16', '32', '32', '64', '64']);
    expect(fitBucket(192)).toBeNull();
    expect(fitBucket(null)).toBeNull();
    expect(fitBucket(0)).toBeNull();
  });
});

describe('formatting', () => {
  it('writes context windows like the library page', () => {
    expect(formatContext(262144)).toBe('256K');
    expect(formatContext(256000)).toBe('256K');
    expect(formatContext(131072)).toBe('128K');
    expect(formatContext(40960)).toBe('40K');
    expect(formatContext(1048576)).toBe('1M');
    expect(formatContext(2000000)).toBe('2M');
    expect(formatContext(null)).toBe('');
  });

  it('shortens pull counts', () => {
    expect(formatCount(25190641)).toBe('25M');
    expect(formatCount(6304540)).toBe('6.3M');
    expect(formatCount(243438)).toBe('243K');
    expect(formatCount(1000)).toBe('1K');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1.2e9)).toBe('1.2B');
    expect(formatCount(null)).toBe('');
  });

  it('writes rates and time left', () => {
    expect(formatRate(12e6)).toBe('12 MB/s');
    expect(formatRate(4.5e6)).toBe('4.5 MB/s');
    expect(formatRate(512e3)).toBe('512 KB/s');
    expect(formatRate(0)).toBe('');
    expect(formatEta(45)).toBe('45 s left');
    expect(formatEta(180)).toBe('3 min left');
    expect(formatEta(3900)).toBe('1 h 5 min left');
    expect(formatEta(7200)).toBe('2 h left');
    expect(formatEta(null)).toBe('');
  });

  it('describes a job in one line', () => {
    expect(jobProgressText({ status: 'running', completedBytes: 2.1 * GB, totalBytes: 6.6 * GB, bytesPerSec: 12e6, etaSec: 180 }))
      .toBe('2.1 of 6.6 GB, 12 MB/s, 3 min left');
    expect(jobProgressText({ status: 'running', completedBytes: 512e6, totalBytes: 815e6 })).toBe('512 of 815 MB');
    expect(jobProgressText({ status: 'running', message: 'Verifying', completedBytes: 271e6, totalBytes: 271e6, bytesPerSec: 2e6, etaSec: 0 }))
      .toBe('271 of 271 MB, Verifying');
    expect(jobProgressText({ status: 'running', pct: 42 })).toBe('42%');
    expect(jobProgressText({ status: 'queued', pct: 0 })).toBe('Queued');
    expect(jobProgressText({ status: 'canceling' })).toBe('Canceling');
    expect(jobProgressText({ status: 'running' })).toBe('Starting');
    expect(jobProgressText(null)).toBe('');
  });

  it('says how long ago a check ran', () => {
    const now = Date.parse('2026-11-12T12:00:00Z');
    expect(formatAgo('2026-11-12T11:59:30Z', now)).toBe('just now');
    expect(formatAgo('2026-11-12T11:55:00Z', now)).toBe('5 min ago');
    expect(formatAgo('2026-11-12T09:00:00Z', now)).toBe('3 h ago');
    expect(formatAgo('2026-11-10T12:00:00Z', now)).toBe('2 d ago');
    expect(formatAgo(null, now)).toBe('');
    expect(formatAgo('not a date', now)).toBe('');
  });
});

describe('names', () => {
  it('compares names with and without the latest tag', () => {
    expect(normalizeModelName('Dolphin3')).toBe('dolphin3:latest');
    expect(normalizeModelName('qwen3:8b')).toBe('qwen3:8b');
    expect(normalizeModelName('hf.co/user/repo')).toBe('hf.co/user/repo:latest');
    expect(baseModelName('qwen3:8b')).toBe('qwen3');
    expect(baseModelName('huihui_ai/qwen3-abliterated:8b')).toBe('huihui_ai/qwen3-abliterated');
    expect(pullName({ id: 'dolphin-mixtral', ollamaId: 'dolphin-mixtral:8x7b' })).toBe('dolphin-mixtral:8x7b');
    expect(pullName({ id: 'qwen3:8b' })).toBe('qwen3:8b');
  });

  it('maps a job back to the picker row that pulls it', () => {
    expect(rowIdForName('dolphin-mixtral:8x7b', CATALOG)).toBe('dolphin-mixtral');
    expect(rowIdForName('dolphin3:latest', CATALOG)).toBe('dolphin3');
    expect(rowIdForName('dolphin3', CATALOG)).toBe('dolphin3');
    expect(rowIdForName('qwen3.5:9b', CATALOG)).toBe('qwen3.5:9b');
    expect(rowIdForName('Foo/Bar:Q4', CATALOG)).toBe('foo/bar:q4');
    expect(rowIdForName('qwen3:8b', OWNER)).toBe('qwen3:8b');
    expect(rowIdForName('', CATALOG)).toBe('');
  });

  it('knows when a pull is an update of an installed name', () => {
    expect(isInstalledName('dolphin3:latest', OWNER)).toBe(true);
    expect(isInstalledName('Dolphin3', OWNER)).toBe(true);
    expect(isInstalledName('qwen3:8b', OWNER)).toBe(true);
    expect(isInstalledName('hermes3:8b', OWNER)).toBe(false);
    expect(isInstalledName('', OWNER)).toBe(false);
  });

  it('spots a search that names one model exactly', () => {
    expect(exactModelName(' qwen3.5:9b ')).toBe('qwen3.5:9b');
    expect(exactModelName('huihui_ai/qwen3-abliterated')).toBe('huihui_ai/qwen3-abliterated');
    expect(exactModelName('hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M')).toBe('hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M');
    for (const q of ['qwen3', 'qwen 3:8b', 'qwen3:', '/qwen', 'a'.repeat(101) + ':x', '']) expect(exactModelName(q), q).toBe('');
  });
});

describe('lists', () => {
  it('puts loaded models first, then sorts by name', () => {
    const sorted = sortInstalled([
      { name: 'qwen3:8b' }, { name: 'dolphin3:latest' }, { name: 'gemma4:12b', loaded: true }, { name: 'gemma4:e4b' }
    ]);
    expect(sorted.map((m) => m.name)).toEqual(['gemma4:12b', 'dolphin3:latest', 'gemma4:e4b', 'qwen3:8b']);
  });

  // From the qwen3.8 tags page on 2026-11-11.
  const QWEN38 = normalizeTags({
    name: 'qwen3.8',
    tags: [
      { name: 'qwen3.8:latest', tag: 'latest', sizeBytes: 18e9, context: 262144 },
      { name: 'qwen3.8:27b', tag: '27b', sizeBytes: 18e9, context: 262144, latest: true },
      { name: 'qwen3.8:27b-mlx', tag: '27b-mlx', sizeBytes: 18e9, mlx: true },
      { name: 'qwen3.8:27b-mlx-bf16', tag: '27b-mlx-bf16', sizeBytes: 56e9, mlx: true },
      { name: 'qwen3.8:27b-q8_0', tag: '27b-q8_0', sizeBytes: 30e9 },
      { name: 'qwen3.8:27b-q4_K_M', tag: '27b-q4_K_M', sizeBytes: 18e9 },
      { name: 'qwen3.8:27b-bf16', tag: '27b-bf16', sizeBytes: 56e9 }
    ]
  }).tags;

  it('offers the default build first, MLX next on Apple silicon, the latest alias last', () => {
    expect(sortTags(QWEN38, { appleSilicon: true }).map((t) => t.tag))
      .toEqual(['27b', '27b-mlx', '27b-mlx-bf16', '27b-q4_K_M', '27b-q8_0', '27b-bf16', 'latest']);
    expect(sortTags(QWEN38).map((t) => t.tag))
      .toEqual(['27b', '27b-q4_K_M', '27b-q8_0', '27b-bf16', '27b-mlx', '27b-mlx-bf16', 'latest']);
  });

  it('keeps latest first when no tag carries the mark, and plain sizes ahead of quantizations', () => {
    const tags = normalizeTags({ tags: [
      { name: 'm:9b-q8_0', sizeBytes: 9e9 }, { name: 'm:9b', sizeBytes: 6e9 }, { name: 'm:4b', sizeBytes: 3e9 }, { name: 'm:latest', sizeBytes: 6e9 }
    ] }).tags;
    expect(sortTags(tags).map((t) => t.tag)).toEqual(['latest', '4b', '9b', '9b-q8_0']);
  });

  it('shows a handful of tags before All tags', () => {
    const apple = sortTags(QWEN38, { appleSilicon: true });
    expect(primaryTagCount(apple, { appleSilicon: true })).toBe(4);
    expect(primaryTagCount(apple.slice(0, 2))).toBe(2);
    expect(primaryTagCount([])).toBe(0);
  });

  it('groups rows by catalog group in catalog order', () => {
    expect(groupByCatalog(CATALOG).map((g) => g.group)).toEqual(['MCQ', 'Small & Fast', 'Powerful', 'Coding', 'Reasoning', 'Vision', 'Uncensored']);
    expect(groupByCatalog([{ id: 'x' }])).toEqual([{ group: 'Models', rows: [{ id: 'x' }] }]);
  });

  it('recommends catalog picks that are not installed and will not swap', () => {
    const groups = recommendedGroups(OWNER, 16);
    const ids = groups.flatMap((g) => g.rows.map((r) => r.id));
    expect(ids).not.toContain('dolphin3');
    expect(ids).not.toContain('qwen3:8b');
    expect(ids).not.toContain('qwen3.8:27b');
    expect(ids).not.toContain('dolphin-mixtral');
    expect(ids).toContain('gemma4:e4b');
    expect(ids).toContain('hermes3:8b');
    expect(groups[0].group).toBe('MCQ');
    expect(groups.find((g) => g.group === 'Small & Fast')?.rows.map((r) => r.id)).toEqual(['lfm3:1.7b', 'qwen3.5:9b', 'gemma4:e4b']);
    expect(recommendedGroups(OWNER, null).flatMap((g) => g.rows).length).toBe(CATALOG.length - 1);
  });

  it('knows installed names whatever the latest tag', () => {
    const set = installedNameSet([{ name: 'dolphin3:latest' }, { name: 'QWEN3:8b' }]);
    expect(set.has(normalizeModelName('dolphin3'))).toBe(true);
    expect(set.has(normalizeModelName('qwen3:8b'))).toBe(true);
    expect(set.has(normalizeModelName('qwen3'))).toBe(false);
  });
});

describe('updateStatus', () => {
  const updates = normalizeUpdates({
    checkedAt: '2026-11-12T10:00:00Z',
    results: { 'qwen3:8b': { status: 'update' }, 'dolphin3:latest': { status: 'current' }, 'odd:1b': { status: 'bogus' } }
  });

  it('reads the verdict for each name', () => {
    expect(updateStatus({ name: 'qwen3:8b', modifiedAt: '2026-09-06T23:05:46.272730223-04:00' }, updates)).toBe('update');
    expect(updateStatus({ name: 'dolphin3:latest' }, updates)).toBe('current');
    expect(updateStatus({ name: 'odd:1b' }, updates)).toBeNull();
    expect(updateStatus({ name: 'new:1b' }, updates)).toBeNull();
    expect(updateStatus({ name: 'qwen3:8b' }, null)).toBeNull();
  });

  it('drops a verdict about a copy pulled again after the check', () => {
    expect(updateStatus({ name: 'qwen3:8b', modifiedAt: '2026-11-12T10:05:00Z' }, updates)).toBeNull();
  });
});

describe('Auto picks from the catalog', () => {
  it('uses qwen3:8b for Auto and dolphin3 for Uncensored on this Mac', () => {
    expect(pickAutoModel(OWNER)?.id).toBe('qwen3:8b');
    expect(pickAutoModel(OWNER, LARGE_CONTEXT_THRESHOLD + 1)?.id).toBe('qwen3:8b');
    expect(pickUncensoredModel(OWNER)?.id).toBe('dolphin3');
  });

  it('gives the same answer with the old catalog, which listed qwen3 itself', () => {
    const old = [
      { id: 'qwen3', label: 'Qwen 3 8B', group: 'Powerful', ollamaId: 'qwen3', available: true },
      { id: 'dolphin3', label: 'Dolphin 3.0 8B', group: 'Uncensored', ollamaId: 'dolphin3', available: true },
      { id: 'llama2-uncensored', label: 'Llama 2 Uncensored', group: 'Uncensored', ollamaId: 'llama2-uncensored', available: false }
    ];
    expect(pickAutoModel(old)?.id).toBe('qwen3');
    expect(pickUncensoredModel(old)?.id).toBe('dolphin3');
  });

  it('takes Small & Fast, then Powerful, then Reasoning, in catalog order', () => {
    const list = listWith({ 'nemotron-3-nano:4b': {}, 'gemma4:12b': {}, 'gemma4:e4b': {}, 'qwen3.5:9b': {} });
    expect(autoCandidates(list).map((m) => m.id)).toEqual(['qwen3.5:9b', 'gemma4:e4b', 'gemma4:12b', 'nemotron-3-nano:4b']);
    expect(pickAutoModel(list)?.id).toBe('qwen3.5:9b');
    expect(pickAutoModel(listWith({ 'nemotron-3-nano:4b': {}, 'gemma4:12b': {} }))?.id).toBe('gemma4:12b');
  });

  it('skips specialists, MCQ builds, uncensored and embedding models', () => {
    const list = listWith(
      { 'glm-ocr': {}, 'mcq-pro-12b': {}, dolphin3: {}, 'rnj-1:8b': {} },
      [
        { id: 'nomic-embed-text:latest', capabilities: ['embedding'] },
        { id: 'mxbai-embed-large:latest' },
        { id: 'huihui_ai/qwen3-abliterated:8b', capabilities: ['completion'] },
        { id: 'phi5:latest', capabilities: ['completion'] }
      ]
    );
    expect(autoCandidates(list).map((m) => m.id)).toEqual(['rnj-1:8b', 'phi5:latest']);
  });

  it('prefers a 128K window for long conversations, else the widest known', () => {
    const list = listWith({
      'lfm3:1.7b': { contextWindow: 32768 },
      'qwen3.5:9b': { contextWindow: 262144 },
      'gemma4:12b': { contextWindow: 131072 }
    });
    expect(pickAutoModel(list, 100)?.id).toBe('lfm3:1.7b');
    expect(pickAutoModel(list, LARGE_CONTEXT_THRESHOLD + 1)?.id).toBe('qwen3.5:9b');
    const narrow = listWith({ 'lfm3:1.7b': { contextWindow: 32768 }, 'gemma4:12b': { contextWindow: 65536 } });
    expect(pickAutoModel(narrow, 20000)?.id).toBe('gemma4:12b');
    const unknown = listWith({ 'lfm3:1.7b': {}, 'gemma4:12b': {} });
    expect(pickAutoModel(unknown, 20000)?.id).toBe('lfm3:1.7b');
  });

  it('falls back to any installed chat model, and to nothing', () => {
    expect(pickAutoModel(listWith({ dolphin3: {} }))?.id).toBe('dolphin3');
    expect(pickAutoModel(listWith({}, [{ id: 'nomic-embed-text:latest', capabilities: ['embedding'] }]))).toBeNull();
    expect(pickAutoModel([])).toBeNull();
    expect(pickAutoModel(undefined)).toBeNull();
  });

  it('orders uncensored picks: the group, then the flag, then the name test', () => {
    expect(pickUncensoredModel(listWith({ 'hermes3:8b': {}, dolphin3: {} }))?.id).toBe('dolphin3');
    expect(pickUncensoredModel(listWith({ 'mcq-raw-8b': {} }))?.id).toBe('mcq-raw-8b');
    expect(pickUncensoredModel(listWith({}, [{ id: 'huihui_ai/qwen3-abliterated:8b' }]))?.id).toBe('huihui_ai/qwen3-abliterated:8b');
    expect(pickUncensoredModel(listWith({ 'qwen3.5:9b': {} }))).toBeNull();
    expect(isUncensoredModelRecord({ id: 'someone/gemma4-heretic:12b' })).toBe(true);
    expect(isUncensoredModelRecord({ id: 'llama4.1:surge' })).toBe(false);
    expect(isUncensoredModelRecord({ id: 'qwen3:8b', group: 'Powerful' })).toBe(false);
  });

  it('tells embedding models apart by capability, or by name without one', () => {
    expect(isEmbeddingOnly({ id: 'x', capabilities: ['embedding'] })).toBe(true);
    expect(isEmbeddingOnly({ id: 'x-embed', capabilities: ['completion', 'embedding'] })).toBe(false);
    expect(isEmbeddingOnly({ id: 'nomic-embed-text' })).toBe(true);
    expect(isEmbeddingOnly({ id: 'qwen3:8b' })).toBe(false);
  });
});

describe('payloads', () => {
  it('fills every field of the installed payload', () => {
    const p = normalizeInstalled(undefined);
    expect(p.runtime).toEqual({
      reachable: true, version: null, latest: null, updateAvailable: false, install: 'unknown', updateCommand: null, downloadUrl: DOWNLOAD_URL
    });
    expect(p.disk).toEqual({ path: '', freeBytes: null, totalBytes: null });
    expect(p.models).toEqual([]);
  });

  it('keeps the contract fields and drops unsafe links and nameless rows', () => {
    const p = normalizeInstalled({
      runtime: { reachable: false, version: '0.20.5', latest: '0.40.16', updateAvailable: true, install: 'homebrew', updateCommand: 'brew upgrade ollama', downloadUrl: 'javascript:alert(1)' },
      disk: { path: '/Users/me/.ollama/models', freeBytes: 112e9, totalBytes: 460e9 },
      models: [
        { name: 'dolphin3:latest', sizeBytes: 4920757726, loaded: true, uncensored: true, capabilities: ['completion', 7], catalog: { id: 'dolphin3', label: 'Dolphin 3.0 8B', group: 'Uncensored' } },
        { name: '' }
      ]
    });
    expect(p.runtime.reachable).toBe(false);
    expect(p.runtime.updateCommand).toBe('brew upgrade ollama');
    expect(p.runtime.downloadUrl).toBe(DOWNLOAD_URL);
    expect(p.disk.freeBytes).toBe(112e9);
    expect(p.models).toHaveLength(1);
    expect(p.models[0]).toMatchObject({ name: 'dolphin3:latest', loaded: true, uncensored: true, capabilities: ['completion'], catalog: { id: 'dolphin3', label: 'Dolphin 3.0 8B', group: 'Uncensored' } });
    expect(normalizeInstalled({ models: [{ name: 'a:1b', catalog: { label: 'no id' } }] }).models[0].catalog).toBeNull();
  });

  it('keeps known capabilities and the paging flags of a library page', () => {
    const p = normalizeLibrary({ page: 2, hasMore: true, results: [{ name: 'qwen3.5', capabilities: ['vision', 'cloud', 'tools'], sizes: ['4b'], pulls: 25190641 }, { description: 'no name' }] });
    expect(p).toMatchObject({ page: 2, hasMore: true, goDark: false, stale: false });
    expect(p.results).toEqual([{ name: 'qwen3.5', description: '', capabilities: ['vision', 'tools'], sizes: ['4b'], pulls: 25190641, tags: null, updated: null }]);
    expect(normalizeLibrary({ goDark: true }).goDark).toBe(true);
  });

  it('derives a missing tag from the name', () => {
    expect(normalizeTags({ tags: [{ name: 'qwen3.5:9b', sizeBytes: 6.6e9 }] }).tags[0]).toMatchObject({ tag: '9b', mlx: false, latest: false, context: null });
  });

  it('treats an ended job as done and reads the byte fields', () => {
    expect(normalizeJob({ id: 'j', status: 'failed', error: 'Disk full. Free some space, then retry.' })).toMatchObject({ done: true, error: 'Disk full. Free some space, then retry.' });
    expect(normalizeJob({ id: 'j', status: 'running', completedBytes: 1, totalBytes: 2, bytesPerSec: 3, etaSec: 4 }))
      .toMatchObject({ done: false, completedBytes: 1, totalBytes: 2, bytesPerSec: 3, etaSec: 4 });
    expect(normalizeJob({ id: 'j', status: 'weird' }).status).toBe('running');
  });
});

describe('libraryQuery', () => {
  it('builds the Discover query', () => {
    const q = new URLSearchParams(libraryQuery({ query: ' qwen ', caps: ['tools', 'vision', 'nope'], fits: true, ramGb: 16, order: 'newest', page: 2 }));
    expect(q.get('q')).toBe('qwen');
    expect(q.getAll('c')).toEqual(['tools', 'vision']);
    expect(q.get('s')).toBe('8');
    expect(q.get('o')).toBe('newest');
    expect(q.get('page')).toBe('2');
  });

  it('leaves out what is not set', () => {
    const q = new URLSearchParams(libraryQuery({ fits: true, ramGb: null }));
    expect(q.has('q')).toBe(false);
    expect(q.has('s')).toBe(false);
    expect(q.get('o')).toBe('popular');
    expect(q.get('page')).toBe('1');
    expect(new URLSearchParams(libraryQuery({ fits: false, ramGb: 16 })).has('s')).toBe(false);
  });
});

describe('followInstallJob', () => {
  const job = (over) => normalizeJob({ id: 'j1', modelId: 'qwen3.5:9b', status: 'running', ...over });
  const run = (first, polls, extra = {}) => {
    const seen = [];
    const queue = [...polls];
    const poll = vi.fn(async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    });
    const ctrl = extra.ctrl || new AbortController();
    const done = followInstallJob(first, { signal: ctrl.signal, onProgress: (j) => seen.push(j.pct), poll, sleep: async () => {}, ...extra.opts });
    return { done, seen, poll, ctrl };
  };

  it('follows a job to completion, never moving progress back', async () => {
    const { done, seen, poll } = run(job({ status: 'queued', pct: null }), [
      job({ pct: 40 }), job({ pct: 10 }), job({ pct: 70 }), job({ status: 'completed', pct: 100 })
    ]);
    expect(await done).toEqual({ status: 'completed', error: '' });
    expect(seen).toEqual([null, 40, 40, 70, 100]);
    expect(poll).toHaveBeenCalledTimes(4);
    expect(poll.mock.calls[0][0]).toBe('j1');
  });

  it('reports a failed job with its sentence, and a canceled one', async () => {
    expect(await run(job({}), [job({ status: 'failed', error: 'Disk full. Free some space, then retry.' })]).done)
      .toEqual({ status: 'failed', error: 'Disk full. Free some space, then retry.' });
    expect(await run(job({ status: 'canceled', done: true }), []).done).toEqual({ status: 'canceled', error: '' });
  });

  it('calls a job the backend forgot an interrupted download', async () => {
    const { done } = run(job({}), [new Error('Install job not found. Refresh the list.')]);
    expect(await done).toEqual({ status: 'failed', error: JOB_LOST });
  });

  it('rides out a few failed polls, then gives up with the reason', async () => {
    const flaky = run(job({}), [new TypeError('Failed to fetch'), job({ pct: 50 }), job({ status: 'completed', pct: 100 })]);
    expect((await flaky.done).status).toBe('completed');
    const down = run(job({}), Array.from({ length: 3 }, () => new TypeError('Failed to fetch')), {
      opts: { retries: 3, describe: () => 'Backend unreachable. Check that it is running.' }
    });
    expect(await down.done).toEqual({ status: 'failed', error: 'Backend unreachable. Check that it is running.' });
    expect(down.poll).toHaveBeenCalledTimes(3);
  });

  it('stops quietly when canceled from here', async () => {
    const ctrl = new AbortController();
    const sleep = vi.fn(async () => { ctrl.abort(); });
    const { done, poll } = run(job({ pct: 5 }), [job({ pct: 6 })], { ctrl, opts: { sleep } });
    expect(await done).toEqual({ status: 'aborted', error: '' });
    expect(poll).not.toHaveBeenCalled();
  });

  it('waits between polls with the real timer, and an abort cuts the wait short', async () => {
    const ctrl = new AbortController();
    const started = Date.now();
    const done = followInstallJob(job({}), { signal: ctrl.signal, onProgress: () => {}, poll: vi.fn(), intervalMs: 60000 });
    setTimeout(() => ctrl.abort(), 10);
    expect(await done).toEqual({ status: 'aborted', error: '' });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('requests', () => {
  const request = vi.mocked(apiFetch);
  beforeEach(() => { request.mockReset(); });

  it('reads installed models and the update check', async () => {
    request.mockResolvedValueOnce({ runtime: { reachable: true }, models: [{ name: 'qwen3:8b' }] });
    expect((await fetchInstalled()).models[0].name).toBe('qwen3:8b');
    expect(request.mock.calls[0][0]).toBe('/api/models/installed');
    request.mockResolvedValueOnce({ checkedAt: null, goDark: true, results: {} });
    expect((await fetchUpdates()).goDark).toBe(true);
    expect(request.mock.calls[1][0]).toBe('/api/models/updates');
    request.mockResolvedValueOnce({});
    await fetchUpdates({ refresh: true });
    expect(request.mock.calls[2][0]).toBe('/api/models/updates?refresh=1');
  });

  it('searches the library and sends a namespaced name as one segment', async () => {
    request.mockResolvedValueOnce({ results: [] });
    await fetchLibrary({ query: 'qwen', caps: ['tools'] });
    expect(request.mock.calls[0][0]).toBe('/api/models/library?q=qwen&c=tools&o=popular&page=1');
    request.mockResolvedValueOnce({ name: 'user/model', tags: [] });
    await fetchLibraryTags('user/model');
    expect(request.mock.calls[1][0]).toBe('/api/models/library/user%2Fmodel/tags');
  });

  it('looks a name up in the registry, local only under Go Dark', async () => {
    request.mockResolvedValueOnce({ status: 'found', sizeBytes: 6.6e9, size: '6.6 GB' });
    expect(await lookupRegistry('qwen3.5:9b')).toEqual({ status: 'found', sizeBytes: 6.6e9, size: '6.6 GB' });
    expect(request.mock.calls[0][0]).toBe('/api/models/registry-lookup?id=qwen3.5%3A9b');
    request.mockResolvedValueOnce({ status: 'odd' });
    expect((await lookupRegistry('x:1b', { localOnly: true })).status).toBe('unknown');
    expect(request.mock.calls[1][0]).toBe('/api/models/registry-lookup?id=x%3A1b&localOnly=1');
  });

  it('starts, polls, lists and cancels install jobs', async () => {
    request.mockResolvedValueOnce({ job: { id: 'j1', modelId: 'qwen3.5:9b', status: 'queued' } });
    expect((await startInstallJob('qwen3.5:9b')).id).toBe('j1');
    expect(request).toHaveBeenLastCalledWith('/api/models/install-jobs', { method: 'POST', body: { modelId: 'qwen3.5:9b' } });
    request.mockResolvedValueOnce({ job: { id: 'j1', status: 'running', pct: 40 } });
    expect((await getInstallJob('j1')).pct).toBe(40);
    request.mockResolvedValueOnce({ jobs: [{ id: 'j1', status: 'running' }, { status: 'running' }] });
    expect((await listInstallJobs()).map((j) => j.id)).toEqual(['j1']);
    request.mockResolvedValueOnce({ job: { id: 'j1' }, cancelRequested: true });
    await cancelInstallJob('j1');
    expect(request).toHaveBeenLastCalledWith('/api/models/install-jobs/j1/cancel', { method: 'POST' });
  });

  it('deletes by the encoded name', async () => {
    request.mockResolvedValueOnce({ ok: true });
    await deleteInstalledModel('user/model:8b');
    expect(request.mock.calls[0][0]).toBe('/api/models/user%2Fmodel%3A8b');
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
  });
});
