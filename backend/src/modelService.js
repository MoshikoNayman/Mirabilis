// @ts-check
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamOllamaChat, listOllamaModels, getOllamaModelInfo } from './providers/ollama.js';
import { streamOpenAICompatibleChat, listOpenAICompatibleModels } from './providers/openaiCompatible.js';
import { listAnthropicModels, streamAnthropicChat } from './providers/anthropic.js';
import { assertSafeProviderUrl } from './security.js';
import { getModels as getCatalogModels, refreshCatalog, getProviderDefault, ollamaTag, catalogRowFor, UNCENSORED_NAME_RE } from './modelCatalog.js';

// The suggested-model catalog is backend/models.json, loaded by modelCatalog.js.
// getModels() is synchronous; a background refresh lands on the next call.

// Built per call so callers see the refreshed catalog.
export function curatedOllamaIds() {
  return new Set(getCatalogModels().map((m) => m.ollamaId || m.id));
}

/** Comparison key: the daemon matches names case-insensitively. */
function tagKey(name) {
  return ollamaTag(name).toLowerCase();
}

/** The model name without its tag. */
function baseOf(name) {
  const key = tagKey(name);
  return key.slice(0, key.lastIndexOf(':'));
}

/**
 * The installed tag a requested Ollama model runs as: a catalog row's own tag,
 * then the exact tag, then another tag of the same model, then the first one
 * installed.
 * @param {string[]} installed names from /api/tags
 * @param {string} [requested]
 * @param {Array<{id: string, ollamaId?: string}>} [catalog]
 * @returns {string}
 */
export function resolveOllamaModel(installed, requested, catalog = getCatalogModels()) {
  const want = String(requested || '').trim();
  if (installed.length === 0) return want;
  const byKey = new Map(installed.map((name) => [tagKey(name), name]));
  // The picker sends the row id; dolphin-mixtral means its 8x7b tag, not :latest.
  const row = want ? catalog.find((m) => m.id === want) : undefined;
  const ofRow = row?.ollamaId ? byKey.get(tagKey(row.ollamaId)) : undefined;
  if (ofRow) return ofRow;
  if (want) {
    const exact = byKey.get(tagKey(want));
    if (exact) return exact;
    const sibling = installed.find((name) => baseOf(name) === baseOf(want));
    if (sibling) return sibling;
  }
  return installed[0];
}

function normalizeModelId(modelId) {
  // Installed models come back as name:tag; curated entries match on the base name.
  return String(modelId || '').split(':')[0];
}

function prettifyEndpointModelLabel(rawId) {
  const raw = String(rawId || '').trim();
  if (!raw) return 'model';
  let value = raw.includes('\\') ? (raw.split('\\').pop() || raw) : raw;
  value = value.includes('/') ? (value.split('/').pop() || value) : value;
  value = value.replace(/^koboldcpp\//i, '');
  value = value.replace(/\.gguf$/i, '');
  return value || raw;
}

function normalizeCatalogNeedle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function listLocalGgufModels() {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const modelsDir = join(thisDir, '..', '..', 'models');
    const entries = await readdir(modelsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.gguf$/i.test(entry.name))
      .map((entry) => {
        const base = entry.name.replace(/\.gguf$/i, '');
        return {
          id: `local:${base}`,
          label: base,
          group: 'Local GGUF files',
          available: true,
          selected: false,
          paramSize: null,
          modelFilePath: join(modelsDir, entry.name)
        };
      });
  } catch {
    return [];
  }
}

function buildEndpointCatalog({ remoteModels, selectedModelId, localModels }) {
  const remotes = Array.isArray(remoteModels) ? remoteModels : [];
  const locals = Array.isArray(localModels) ? localModels : [];
  const remoteById = new Map(remotes.map((m) => [String(m.id || '').trim(), m]));
  const unmatchedRemoteIds = new Set(remoteById.keys());
  const localById = new Map(locals.map((m) => [String(m.id || '').trim(), m]));
  const unmatchedLocalIds = new Set(localById.keys());

  const catalog = getCatalogModels().map((entry) => {
    const entryNeedle = normalizeCatalogNeedle(`${entry.id} ${entry.ollamaId || ''} ${entry.label}`);
    /** @type {any} */
    let matchedRemote = null;
    /** @type {any} */
    let matchedLocal = null;

    // A specific tag must match in full, so gemma3:latest (4B) is not taken for gemma3:1b.
    const ollamaId = entry.ollamaId || '';
    const ollamaHasSpecificTag = ollamaId.includes(':') && !ollamaId.endsWith(':latest');
    const specificTagNeedle = ollamaHasSpecificTag ? normalizeCatalogNeedle(ollamaId) : null;

    for (const [remoteId, remote] of remoteById.entries()) {
      // Skip remotes already claimed by an earlier catalog entry (e.g. gemma3:1b
      // must not also satisfy the untagged gemma3 entry).
      if (!unmatchedRemoteIds.has(remoteId)) continue;
      const remoteNeedle = normalizeCatalogNeedle(remoteId);
      const base = normalizeCatalogNeedle(normalizeModelId(remoteId));
      const matched = specificTagNeedle
        ? remoteNeedle === specificTagNeedle || remoteNeedle.startsWith(specificTagNeedle + ' ')
        : (
          remoteNeedle.includes(normalizeCatalogNeedle(normalizeModelId(entry.id))) ||
          remoteNeedle.includes(normalizeCatalogNeedle(normalizeModelId(ollamaId))) ||
          (entryNeedle && base && entryNeedle.includes(base))
        );
      if (matched) {
        matchedRemote = remote;
        unmatchedRemoteIds.delete(remoteId);
        break;
      }
    }

    if (!matchedRemote) {
      for (const [localId, local] of localById.entries()) {
        const localNeedle = normalizeCatalogNeedle(local.label || localId);
        const entryIdNeedle = normalizeCatalogNeedle(normalizeModelId(entry.id));
        const entryOllamaNeedle = normalizeCatalogNeedle(normalizeModelId(entry.ollamaId || ''));
        if (
          localNeedle === entryIdNeedle ||
          (entryOllamaNeedle && localNeedle === entryOllamaNeedle)
        ) {
          matchedLocal = local;
          unmatchedLocalIds.delete(localId);
          break;
        }
      }
    }

    if (matchedRemote) {
      return {
        ...entry,
        id: matchedRemote.id,
        label: entry.label,
        available: true,
        selected: String(matchedRemote.id) === String(selectedModelId || ''),
        paramSize: matchedRemote.paramSize || null
      };
    }

    if (matchedLocal) {
      return {
        ...entry,
        id: matchedLocal.id,
        label: entry.label,
        available: true,
        selected: String(matchedLocal.id) === String(selectedModelId || ''),
        paramSize: matchedLocal.paramSize || null,
        modelFilePath: matchedLocal.modelFilePath
      };
    }

    // These endpoints load one GGUF at launch and cannot pull, so an install row
    // would be a dead end.
    return null;
  }).filter(Boolean);

  const extras = Array.from(unmatchedRemoteIds)
    .map((id) => remoteById.get(id))
    .filter(Boolean)
    .map((item) => ({
      id: item.id,
      label: item.label || prettifyEndpointModelLabel(item.id),
      group: 'Loaded by endpoint',
      available: true,
      selected: String(item.id) === String(selectedModelId || ''),
      paramSize: item.paramSize || null
    }));

  const localExtras = Array.from(unmatchedLocalIds)
    .map((id) => localById.get(id))
    .filter(Boolean)
    .map((item) => ({
      id: item.id,
      label: item.label,
      group: item.group || 'Local GGUF files',
      available: true,
      selected: String(item.id) === String(selectedModelId || ''),
      paramSize: item.paramSize || null,
      modelFilePath: item.modelFilePath
    }));

  const combined = /** @type {import('./types.js').ModelListItem[]} */ (
    [...catalog, ...localExtras, ...extras].filter(Boolean)
  );
  if (!combined.some((item) => item.selected)) {
    const firstAvailable = combined.find((item) => item.available === true);
    if (firstAvailable) {
      return combined.map((item) => ({
        ...item,
        selected: item.id === firstAvailable.id
      }));
    }
  }

  return combined;
}

/** @param {{ provider?: string, model?: string, config: any }} args @returns {Promise<string>} */
export async function getEffectiveModel({ provider, model, config }) {
  if (provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'gpuaas' || provider === 'openai-compatible' || provider === 'vllm') {
    // vLLM is remote: no local GGUF, and its key is optional.
    const isCloudOnly = provider !== 'openai-compatible';
    let preferred = model && model !== 'auto' ? model : (isCloudOnly ? null : config.openAIModel);
    // Guard: reject local GGUF filenames being sent to cloud APIs
    if (isCloudOnly && preferred && preferred.toLowerCase().endsWith('.gguf')) preferred = null;
    if (preferred && preferred !== 'auto') return preferred;
    if (provider === 'vllm') return config.openAIModel || 'model';
    if (provider === 'gpuaas') return config.openAIModel || 'model';
    // From models.json, so a new flagship does not need an app release to
    // become the fallback. Only reached when the live listing failed.
    const fallback = getProviderDefault(provider);
    if (fallback) return fallback;
    return config.openAIModel || 'model.gguf';
  }
  if (provider === 'claude') {
    const preferred = model && model !== 'auto' ? model : config.openAIModel;
    if (preferred && preferred !== 'auto') return preferred;
    return getProviderDefault('claude');
  }
  if (provider === 'koboldcpp') {
    const preferred = model && model !== 'auto' ? model : (config.koboldModel || config.openAIModel);
    if (preferred && preferred !== 'auto') return preferred;
    return 'koboldcpp';
  }
  if (provider === 'llamacpp') {
    // llama-server serves the launched model, so the caller's choice stands.
    const preferred = model && model !== 'auto' ? model : config.openAIModel;
    if (preferred && preferred !== 'auto') return preferred;
    return 'llama.cpp';
  }

  // Ollama: the requested model if installed, else the first installed one.
  const preferred = model || config.ollamaModel;
  try {
    const res = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const body = await res.json();
      const installed = (body.models || []).map(m => m?.name).filter((n) => typeof n === 'string' && n);
      if (installed.length > 0) return resolveOllamaModel(installed, preferred);
    }
  } catch {
    // Unreachable: return preferred and let the stream report the error.
  }
  return preferred;
}

export async function listModels(config, provider = config.aiProvider, options = {}) {
  const overrideBaseUrl = typeof options?.overrideBaseUrl === 'string' ? options.overrideBaseUrl.trim() : '';
  const overrideApiKey = typeof options?.overrideApiKey === 'string' ? options.overrideApiKey.trim() : undefined;

  if (provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'gpuaas' || provider === 'openai-compatible' || provider === 'vllm') {
    const defaultBase = provider === 'openai'
      ? 'https://api.openai.com/v1'
      : provider === 'grok'
      ? 'https://api.x.ai/v1'
      : provider === 'groq'
      ? 'https://api.groq.com/openai/v1'
      : provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : provider === 'gemini'
      ? 'https://generativelanguage.googleapis.com/v1beta/openai'
      : provider === 'cerebras'
      ? 'https://api.cerebras.ai/v1'
      : provider === 'gpuaas'
      ? ''
      : provider === 'vllm'
      ? 'http://127.0.0.1:8000/v1'
      : config.openAIBaseUrl;

    // A remote API cannot load local GGUF files, so cloud providers never list them.
    const isCloudOnly = provider !== 'openai-compatible';
    // Used when the remote listing fails.
    const providerFallbackModel = (provider === 'gpuaas' || provider === 'vllm')
      // No meaningful default: the user points these at their own server, which
      // lists its own models.
      ? null
      : (getProviderDefault(provider) || (provider === 'openai-compatible' ? config.openAIModel : null));

    const baseUrl = overrideBaseUrl || defaultBase;
    const apiKey = overrideApiKey !== undefined ? overrideApiKey : config.openAIApiKey;
    const remote = await listOpenAICompatibleModels({ baseUrl, apiKey }).catch(() => []);
    const locals = isCloudOnly ? [] : await listLocalGgufModels();
    if (remote.length > 0) {
      // The config model may be a local GGUF path, so cloud providers let the UI pick.
      const selectedId = isCloudOnly ? '' : config.openAIModel;
      return buildEndpointCatalog({ remoteModels: remote, selectedModelId: selectedId, localModels: locals });
    }
    if (locals.length > 0) {
      return buildEndpointCatalog({ remoteModels: [], selectedModelId: config.openAIModel, localModels: locals });
    }
    if (!providerFallbackModel) return []; // gpuaas with no config yet
    return [{
      id: providerFallbackModel,
      label: prettifyEndpointModelLabel(providerFallbackModel),
      group: 'Configured endpoint',
      available: true,
      selected: true,
      paramSize: null
    }];
  }

  if (provider === 'claude') {
    const baseUrl = overrideBaseUrl || 'https://api.anthropic.com';
    const apiKey = overrideApiKey !== undefined ? overrideApiKey : config.openAIApiKey;
    const remote = await listAnthropicModels({ baseUrl, apiKey }).catch(() => []);
    if (remote.length > 0) {
      const selectedId = config.openAIModel;
      return remote.map((item) => ({
        id: item.id,
        label: item.label || prettifyEndpointModelLabel(item.id),
        group: 'Anthropic Models',
        available: true,
        selected: String(item.id) === String(selectedId || ''),
        paramSize: null
      }));
    }
    return [{
      id: config.openAIModel || getProviderDefault('claude'),
      label: prettifyEndpointModelLabel(config.openAIModel || getProviderDefault('claude')),
      group: 'Anthropic Models',
      available: true,
      selected: true,
      paramSize: null
    }];
  }

  if (provider === 'koboldcpp') {
    const baseUrl = overrideBaseUrl || config.koboldBaseUrl;
    const remote = await listOpenAICompatibleModels({ baseUrl, apiKey: '' }).catch(() => []);
    const locals = await listLocalGgufModels();
    if (remote.length > 0) {
      const selectedId = config.koboldModel || remote[0]?.id || 'koboldcpp';
      return buildEndpointCatalog({ remoteModels: remote, selectedModelId: selectedId, localModels: locals });
    }
    if (locals.length > 0) {
      return buildEndpointCatalog({ remoteModels: [], selectedModelId: config.koboldModel || locals[0]?.id, localModels: locals });
    }
    return [{
      id: config.koboldModel || 'koboldcpp',
      label: prettifyEndpointModelLabel(config.koboldModel || 'koboldcpp'),
      group: 'Configured endpoint',
      available: true,
      selected: true,
      paramSize: null
    }];
  }

  if (provider === 'llamacpp') {
    // Served model plus local GGUF files. Empty when nothing runs, so the UI shows
    // the launch control instead of a phantom entry.
    const baseUrl = overrideBaseUrl || 'http://127.0.0.1:8080/v1';
    const remote = await listOpenAICompatibleModels({ baseUrl, apiKey: '' }).catch(() => []);
    const locals = await listLocalGgufModels();
    if (remote.length > 0) {
      return buildEndpointCatalog({ remoteModels: remote, selectedModelId: remote[0]?.id, localModels: locals });
    }
    if (locals.length > 0) {
      return buildEndpointCatalog({ remoteModels: [], selectedModelId: locals[0]?.id, localModels: locals });
    }
    return [];
  }

  // options.catalog is a test seam; normally the merged models.json.
  /** @type {import('./modelCatalog.js').CatalogModel[]} */
  const catalog = Array.isArray(options?.catalog) ? options.catalog : getCatalogModels();
  const discoveredModels = await listOllamaModels(config.ollamaBaseUrl);
  const selectedOllamaModel = resolveOllamaModel(discoveredModels.map((m) => m.name), config.ollamaModel, catalog);
  const installedByTag = new Map(discoveredModels.map((m) => [tagKey(m.name), m]));
  const facts = await describeInstalled(config.ollamaBaseUrl, discoveredModels);

  // A row is installed only when its own tag is (a bare id is id:latest), so
  // qwen3.8:27b-mlx or qwen3.8:latest never mark the qwen3.8:27b row.
  const claimed = new Set();
  const curated = catalog.map((model) => {
    const key = tagKey(model.ollamaId || model.id);
    const installed = installedByTag.get(key);
    if (!installed) {
      return { ...model, available: false, selected: false, paramSize: null, sizeBytes: null, quant: null };
    }
    claimed.add(key);
    return {
      ...model,
      available: true,
      selected: installed.name === selectedOllamaModel,
      ...installedFields(installed, facts)
    };
  });

  // Every other installed tag is listed under its own name, even when a
  // catalog row shares its base name. Another tag of an uncensored row, or a
  // name that says so, is flagged, so Auto leaves it alone.
  const extraModels = discoveredModels
    .filter((m) => !claimed.has(tagKey(m.name)))
    .map((m) => {
      const sibling = catalogRowFor(m.name, catalog)?.row;
      const uncensored = sibling?.uncensored === true || sibling?.group === 'Uncensored' || UNCENSORED_NAME_RE.test(m.name);
      return {
        id: m.name,
        label: m.name,
        group: 'Installed locally',
        available: true,
        selected: m.name === selectedOllamaModel,
        ...(uncensored ? { uncensored: true } : {}),
        ...installedFields(m, facts)
      };
    });

  return [...curated, ...extraModels];
}

// /api/show per installed model: a few at a time inside a total budget, so a
// long list or a slow daemon cannot stall the picker. Successes are cached.
const SHOW_CONCURRENCY = 4;
const SHOW_BUDGET_MS = 4000;

/**
 * Capabilities and context window for each installed model. A failed or
 * skipped show leaves capabilities [] and contextWindow null.
 * @param {string} baseUrl
 * @param {Array<{name: string, digest?: string | null}>} installed
 * @returns {Promise<Map<string, {capabilities: string[], contextWindow: number | null}>>}
 */
async function describeInstalled(baseUrl, installed) {
  /** @type {Map<string, {capabilities: string[], contextWindow: number | null}>} */
  const facts = new Map();
  const deadline = Date.now() + SHOW_BUDGET_MS;
  let next = 0;
  async function worker() {
    while (next < installed.length && Date.now() < deadline) {
      const m = installed[next];
      next += 1;
      const info = await getOllamaModelInfo(baseUrl, m.name, { digest: m.digest }).catch(() => null);
      facts.set(m.name, {
        capabilities: Array.isArray(info?.capabilities) ? info.capabilities : [],
        contextWindow: info?.contextWindow ?? null
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(SHOW_CONCURRENCY, installed.length) }, worker));
  return facts;
}

/** Fields only an installed model has; the update checks and Settings read them. */
function installedFields(m, facts) {
  const info = facts.get(m.name);
  return {
    paramSize: m.paramSize || null,
    sizeBytes: m.sizeBytes ?? null,
    quant: m.quant || null,
    digest: m.digest || null,
    modifiedAt: m.modifiedAt || null,
    family: m.family || null,
    format: m.format || null,
    capabilities: info?.capabilities || [],
    contextWindow: info?.contextWindow ?? null
  };
}

export async function streamWithProvider({ provider, model, messages, config, signal, onToken, onStats, onNotice, overrideBaseUrl, overrideApiKey, temperature, maxTokens, ollamaOptions, openaiParams, keepAlive, think }) {
  // SSRF guard: this call echoes the provider body back, so cloud-metadata hosts
  // are refused here too. Loopback and LAN stay allowed for local models.
  if (overrideBaseUrl) assertSafeProviderUrl(overrideBaseUrl);
  if (provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'gpuaas' || provider === 'openai-compatible' || provider === 'vllm') {
    // gpuaas has no default base URL; a local fallback would send the user's API
    // key to 127.0.0.1:8000.
    if (provider === 'gpuaas' && !String(overrideBaseUrl || '').trim()) {
      throw new Error('Set your GPUaaS endpoint URL in the provider config before sending.');
    }
    const defaultBase = provider === 'openai'
      ? 'https://api.openai.com/v1'
      : provider === 'grok'
      ? 'https://api.x.ai/v1'
      : provider === 'groq'
      ? 'https://api.groq.com/openai/v1'
      : provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : provider === 'gemini'
      ? 'https://generativelanguage.googleapis.com/v1beta/openai'
      : provider === 'cerebras'
      ? 'https://api.cerebras.ai/v1'
      : provider === 'gpuaas'
      ? ''
      : provider === 'vllm'
      ? 'http://127.0.0.1:8000/v1'
      : config.openAIBaseUrl;
    return streamOpenAICompatibleChat({
      baseUrl: overrideBaseUrl || defaultBase,
      apiKey: overrideApiKey !== undefined ? overrideApiKey : config.openAIApiKey,
      model,
      messages,
      signal,
      onToken,
      temperature,
      maxTokens,
      params: openaiParams,
      provider,
      providerLabel: provider === 'openai'
        ? 'OpenAI'
        : provider === 'grok'
        ? 'Grok'
        : provider === 'groq'
        ? 'Groq'
        : provider === 'openrouter'
        ? 'OpenRouter'
        : provider === 'gemini'
        ? 'Gemini'
        : provider === 'cerebras'
        ? 'Cerebras'
        : provider === 'gpuaas'
        ? 'GPUaaS'
        : provider === 'vllm'
        ? 'vLLM'
        : 'OpenAI-compatible',
    });
  }

  if (provider === 'koboldcpp' || provider === 'llamacpp') {
    return streamOpenAICompatibleChat({
      baseUrl: overrideBaseUrl || (provider === 'llamacpp' ? 'http://127.0.0.1:8080/v1' : config.koboldBaseUrl),
      apiKey: overrideApiKey !== undefined ? overrideApiKey : '',
      model,
      messages,
      signal,
      onToken,
      temperature,
      maxTokens,
      params: openaiParams,
      providerLabel: provider === 'llamacpp' ? 'llama.cpp' : 'KoboldCpp',
    });
  }

  if (provider === 'claude') {
    return streamAnthropicChat({
      baseUrl: overrideBaseUrl || 'https://api.anthropic.com',
      apiKey: overrideApiKey !== undefined ? overrideApiKey : config.openAIApiKey,
      model,
      messages,
      signal,
      onToken,
      onStats,
      temperature,
      maxTokens,
      providerLabel: 'Claude',
    });
  }

  return streamOllamaChat({
    baseUrl: config.ollamaBaseUrl,
    model,
    messages,
    signal,
    onToken,
    onStats,
    onNotice,
    temperature,
    maxTokens,
    keepAlive,
    think,
    options: ollamaOptions,
  });
}
