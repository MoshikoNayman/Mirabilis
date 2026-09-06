// @ts-check
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamOllamaChat, listOllamaModels } from './providers/ollama.js';
import { streamOpenAICompatibleChat, listOpenAICompatibleModels } from './providers/openaiCompatible.js';
import { listAnthropicModels, streamAnthropicChat } from './providers/anthropic.js';
import { assertSafeProviderUrl } from './security.js';
import { getModels as getCatalogModels, refreshCatalog, getProviderDefault } from './modelCatalog.js';

// The suggested-model catalog now lives in backend/models.json, not here.
//
// It was a hardcoded array, which made every new model upstream a code change
// and an app update for every user. That is the wrong shape for a list whose
// entire job is to track something that moves weekly. modelCatalog.js merges
// the bundled file with a copy refreshed from the repository and an optional
// user file, so adding a model is now editing one JSON file and pushing it.
//
// getModels() is synchronous and always returns a usable list; the refresh
// happens in the background and lands on the next call.

// All valid pull targets - used by the pull endpoint to whitelist requests
// Was exported and never used anywhere: dead since the pull route started
// validating ids by format instead of against a whitelist. Kept as a function
// so anything that wants it gets the CURRENT catalog rather than a snapshot
// taken at import time.
export function curatedOllamaIds() {
  return new Set(getCatalogModels().map((m) => m.ollamaId || m.id));
}

function normalizeModelId(modelId) {
  // Ollama often reports installed models as "name:tag" (e.g. llama3:latest).
  // We normalize to base name so curated entries can match installed tagged variants.
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

    // If this entry targets a specific version tag (e.g. gemma3:1b, gemma4:e2b),
    // require the remote id to contain the full versioned tag - not just the base name.
    // This prevents gemma3:latest (4B) from being mistaken as gemma3:1b (1B).
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

    // Not loaded by the endpoint and no matching local GGUF. This catalog is only
    // built for endpoints that CANNOT pull a model on demand (koboldcpp,
    // openai-compatible) - unlike Ollama, they load a single GGUF at launch. So
    // drop the entry instead of emitting a dead "install" row that, when clicked,
    // only produced a "not available in this endpoint" dead-end.
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
    // vLLM is a remote OpenAI-compatible server: like the cloud providers it
    // never mixes in local GGUF, but (like openai-compatible) its key is optional.
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
    return getProviderDefault('claude') || 'claude-sonnet-5';
  }
  if (provider === 'koboldcpp') {
    const preferred = model && model !== 'auto' ? model : (config.koboldModel || config.openAIModel);
    if (preferred && preferred !== 'auto') return preferred;
    return 'koboldcpp';
  }
  if (provider === 'llamacpp') {
    // The managed llama.cpp server serves whatever model was launched; the
    // effective model is just whatever the caller selected.
    const preferred = model && model !== 'auto' ? model : config.openAIModel;
    if (preferred && preferred !== 'auto') return preferred;
    return 'llama.cpp';
  }

  // For ollama: verify requested/configured model is installed; fall back to first installed model
  const preferred = model || config.ollamaModel;
  try {
    const res = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const body = await res.json();
      const installed = (body.models || []).map(m => m.name);
      if (installed.length > 0) {
        const match = installed.find(n =>
          n === preferred ||
          n.split(':')[0] === preferred ||
          n.split(':')[0] === (preferred || '').split(':')[0]
        );
        return match || installed[0];
      }
    }
  } catch {
    // Ollama not reachable - return preferred and let the stream fail with a clear error
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

    // Cloud-only providers - never mix in local GGUF files; they can't be loaded via a remote API.
    const isCloudOnly = provider !== 'openai-compatible';
    // Per-provider sensible fallback model name (used when remote listing fails/unavailable).
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
      // For cloud providers, don't try to pre-select using the generic config model name
      // (which may be a local GGUF path). Let UI auto-select the first available model.
      const selectedId = isCloudOnly ? '' : config.openAIModel;
      return buildEndpointCatalog({ remoteModels: remote, selectedModelId: selectedId, localModels: locals });
    }
    if (locals.length > 0) {
      return buildEndpointCatalog({ remoteModels: [], selectedModelId: config.openAIModel, localModels: locals });
    }
    if (!providerFallbackModel) return []; // gpuaas with no config yet - return empty
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
    // First-class local llama.cpp engine (managed by /api/runtimes/llamacpp).
    // Its model list is whatever the managed server currently serves, plus any
    // local GGUF files. When nothing is running, return empty so the UI shows
    // the launch control (pick a model + Start) instead of a phantom entry.
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

  const discoveredModels = await listOllamaModels(config.ollamaBaseUrl);
  const selectedOllamaModel = await getEffectiveModel({ provider: 'ollama', config });
  const discoveredSet = new Set(discoveredModels.map((m) => m.name));
  const discoveredBaseSet = new Set(discoveredModels.map((m) => normalizeModelId(m.name)));
  // Two param maps: exact full name (e.g. 'gemma3:latest') and base name (e.g. 'gemma3')
  const paramSizeExact = {};
  const paramSizeBase = {};
  // Parallel maps of on-disk size (bytes) and quant level, so the UI can show a
  // pre-pull Fits/Tight/Will-swap pill against available memory.
  const sizeBytesExact = {};
  const sizeBytesBase = {};
  const quantExact = {};
  const quantBase = {};
  for (const m of discoveredModels) {
    paramSizeExact[m.name] = m.paramSize;
    sizeBytesExact[m.name] = m.sizeBytes;
    quantExact[m.name] = m.quant;
    const base = normalizeModelId(m.name);
    if (!paramSizeBase[base]) paramSizeBase[base] = m.paramSize;
    if (!sizeBytesBase[base]) sizeBytesBase[base] = m.sizeBytes;
    if (!quantBase[base]) quantBase[base] = m.quant;
  }
  const curatedBaseSet = new Set(
    getCatalogModels().flatMap((m) => [
      normalizeModelId(m.id),
      normalizeModelId(m.ollamaId || m.id)
    ])
  );
  const curated = getCatalogModels().map((model) => {
    const pullId = model.ollamaId || model.id;
    // If the ollamaId has a specific non-default tag (e.g. gemma3:1b, gemma3:12b, gemma4:e2b),
    // ONLY match if that exact tag is present in the discovered set.
    // This prevents gemma3:latest from satisfying gemma3:1b just because both share base name 'gemma3'.
    const hasSpecificTag = pullId.includes(':') && !pullId.endsWith(':latest');
    let isAvailable;
    let paramSize;
    if (hasSpecificTag) {
      isAvailable = discoveredSet.has(pullId) || discoveredSet.has(model.id);
      paramSize = paramSizeExact[pullId] || paramSizeExact[model.id] || null;
    } else {
      isAvailable =
        discoveredSet.has(model.id) ||
        discoveredSet.has(pullId) ||
        discoveredBaseSet.has(normalizeModelId(model.id)) ||
        discoveredBaseSet.has(normalizeModelId(pullId));
      paramSize =
        paramSizeExact[model.id] ||
        paramSizeExact[pullId] ||
        paramSizeBase[normalizeModelId(model.id)] ||
        paramSizeBase[normalizeModelId(pullId)] ||
        null;
    }
    const sizeBytes = hasSpecificTag
      ? (sizeBytesExact[pullId] ?? sizeBytesExact[model.id] ?? null)
      : (sizeBytesExact[model.id] ?? sizeBytesExact[pullId]
          ?? sizeBytesBase[normalizeModelId(model.id)] ?? sizeBytesBase[normalizeModelId(pullId)] ?? null);
    const quant = hasSpecificTag
      ? (quantExact[pullId] || quantExact[model.id] || null)
      : (quantExact[model.id] || quantExact[pullId]
          || quantBase[normalizeModelId(model.id)] || quantBase[normalizeModelId(pullId)] || null);
    return {
      ...model,
      available: isAvailable,
      selected: normalizeModelId(model.id) === normalizeModelId(selectedOllamaModel),
      paramSize,
      sizeBytes,
      quant
    };
  });

  const extraModels = discoveredModels
    .filter(({ name }) => !curatedBaseSet.has(normalizeModelId(name)))
    .map(({ name, paramSize, sizeBytes, quant }) => ({
      id: name,
      label: name,
      group: 'Installed locally',
      available: true,
      selected: name === selectedOllamaModel,
      paramSize: paramSize || null,
      sizeBytes: sizeBytes ?? null,
      quant: quant || null
    }));

  return [...curated, ...extraModels];
}

export async function streamWithProvider({ provider, model, messages, config, signal, onToken, onStats, onNotice, overrideBaseUrl, overrideApiKey, temperature, maxTokens, ollamaOptions, openaiParams, keepAlive }) {
  // Central SSRF guard for the streaming path too (not just /api/models and
  // /api/providers/health): this is the one outbound call that echoes the
  // provider response body back to the caller, so a metadata-endpoint baseUrl
  // must be refused here as well. Only blocks cloud-metadata hosts; loopback/LAN
  // (local models) stay allowed.
  if (overrideBaseUrl) assertSafeProviderUrl(overrideBaseUrl);
  if (provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'gpuaas' || provider === 'openai-compatible' || provider === 'vllm') {
    // gpuaas has no default base URL; refuse rather than silently fall back to a
    // local server (which would ship the user's API key to 127.0.0.1:8000).
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
    options: ollamaOptions,
  });
}
