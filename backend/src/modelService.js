import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamOllamaChat, listOllamaModels } from './providers/ollama.js';
import { streamOpenAICompatibleChat, listOpenAICompatibleModels } from './providers/openaiCompatible.js';
import { listAnthropicModels, streamAnthropicChat } from './providers/anthropic.js';
import { assertSafeProviderUrl } from './security.js';

// Curated one-click models for the Ollama panel. Every ollamaId below is verified
// present in the Ollama registry (registry.ollama.ai). Anything not listed can
// still be pulled via the free-text "pull any model" field in the model menu.
const CURATED_OLLAMA_MODELS = [
  // ── MCQ family - Mirabilis native models (built with training/mcq/setup.sh)
  { id: 'mcq-pro-12b',   label: 'MCQ-Pro-12B',   group: 'MCQ', ollamaId: 'mcq-pro-12b',   size: '8.1 GB' },
  { id: 'mcq-ultra-31b', label: 'MCQ-Ultra-31B', group: 'MCQ', ollamaId: 'mcq-ultra-31b', size: '~20 GB' },
  { id: 'mcq-raw-8b',    label: 'MCQ-Raw-8B',    group: 'MCQ', ollamaId: 'mcq-raw-8b',    size: '4.9 GB', uncensored: true },

  // ── Small & Fast - run well on modest hardware (8-16 GB)
  { id: 'llama3.2:3b',  label: 'Llama 3.2 3B',  group: 'Small & Fast', ollamaId: 'llama3.2:3b', size: '2.0 GB' },
  { id: 'gemma3:1b',    label: 'Gemma 3 1B',    group: 'Small & Fast', ollamaId: 'gemma3:1b',   size: '815 MB' },
  { id: 'gemma3',       label: 'Gemma 3 4B',    group: 'Small & Fast', ollamaId: 'gemma3',      size: '3.3 GB' },
  { id: 'phi4-mini',    label: 'Phi-4 Mini',    group: 'Small & Fast', ollamaId: 'phi4-mini',   size: '2.5 GB' },
  { id: 'qwen2.5',      label: 'Qwen 2.5 7B',   group: 'Small & Fast', ollamaId: 'qwen2.5',     size: '4.7 GB' },
  { id: 'mistral',      label: 'Mistral 7B',    group: 'Small & Fast', ollamaId: 'mistral',     size: '4.1 GB' },
  { id: 'llama3.1',     label: 'Llama 3.1 8B',  group: 'Small & Fast', ollamaId: 'llama3.1',    size: '4.7 GB' },

  // ── Powerful - need more RAM/VRAM
  { id: 'gpt-oss:20b',  label: 'GPT-OSS 20B (OpenAI)', group: 'Powerful', ollamaId: 'gpt-oss:20b',   size: '14 GB' },
  { id: 'phi4',         label: 'Phi-4 14B',            group: 'Powerful', ollamaId: 'phi4',          size: '9.1 GB' },
  { id: 'gemma3:12b',   label: 'Gemma 3 12B',          group: 'Powerful', ollamaId: 'gemma3:12b',    size: '8.1 GB' },
  { id: 'gemma3:27b',   label: 'Gemma 3 27B',          group: 'Powerful', ollamaId: 'gemma3:27b',    size: '17 GB'  },
  { id: 'gemma4:e4b',   label: 'Gemma 4 E4B (MoE)',    group: 'Powerful', ollamaId: 'gemma4:e4b',    size: '9.6 GB' },
  { id: 'gemma4:26b',   label: 'Gemma 4 26B',          group: 'Powerful', ollamaId: 'gemma4:26b',    size: '18 GB'  },
  { id: 'gemma4:31b',   label: 'Gemma 4 31B',          group: 'Powerful', ollamaId: 'gemma4:31b',    size: '20 GB'  },
  { id: 'qwen3',        label: 'Qwen 3 8B',            group: 'Powerful', ollamaId: 'qwen3',         size: '5.2 GB' },
  { id: 'qwen3:32b',    label: 'Qwen 3 32B',           group: 'Powerful', ollamaId: 'qwen3:32b',     size: '20 GB'  },
  { id: 'llama3.3',     label: 'Llama 3.3 70B',        group: 'Powerful', ollamaId: 'llama3.3',      size: '43 GB'  },
  { id: 'gpt-oss:120b', label: 'GPT-OSS 120B (OpenAI)',group: 'Powerful', ollamaId: 'gpt-oss:120b',  size: '65 GB'  },
  { id: 'mixtral',      label: 'Mixtral 8x22B',        group: 'Powerful', ollamaId: 'mixtral:8x22b', size: '80 GB'  },
  { id: 'llama4',       label: 'Llama 4 Scout (MoE)',  group: 'Powerful', ollamaId: 'llama4:scout',  size: '67 GB'  },

  // ── Coding
  { id: 'qwen2.5-coder',   label: 'Qwen2.5 Coder 7B',    group: 'Coding', ollamaId: 'qwen2.5-coder',   size: '4.7 GB' },
  { id: 'qwen3-coder:30b', label: 'Qwen3 Coder 30B (MoE)', group: 'Coding', ollamaId: 'qwen3-coder:30b', size: '19 GB' },

  // ── Reasoning
  { id: 'deepseek-r1',     label: 'DeepSeek R1 7B',      group: 'Reasoning', ollamaId: 'deepseek-r1',    size: '4.7 GB' },
  { id: 'deepseek-r1:14b', label: 'DeepSeek R1 14B',     group: 'Reasoning', ollamaId: 'deepseek-r1:14b', size: '9.0 GB' },

  // ── Uncensored / unrestricted community models
  { id: 'dolphin3',                 label: 'Dolphin 3.0 8B',        group: 'Uncensored', ollamaId: 'dolphin3',             size: '4.7 GB', uncensored: true },
  { id: 'dolphin-llama3',           label: 'Dolphin Llama 3 8B',    group: 'Uncensored', ollamaId: 'dolphin-llama3',       size: '4.7 GB', uncensored: true },
  { id: 'dolphin-mistral',          label: 'Dolphin Mistral 7B',    group: 'Uncensored', ollamaId: 'dolphin-mistral',      size: '4.1 GB', uncensored: true },
  { id: 'dolphin-mixtral',          label: 'Dolphin Mixtral 8x7B',  group: 'Uncensored', ollamaId: 'dolphin-mixtral:8x7b', size: '26 GB',  uncensored: true },
  { id: 'wizard-vicuna-uncensored', label: 'Wizard Vicuna Uncens.', group: 'Uncensored', ollamaId: 'wizard-vicuna-uncensored', size: '3.8 GB', uncensored: true },
  { id: 'llama2-uncensored',        label: 'Llama 2 Uncensored',    group: 'Uncensored', ollamaId: 'llama2-uncensored',    size: '3.8 GB', uncensored: true },
];

// All valid pull targets - used by the pull endpoint to whitelist requests
export const CURATED_OLLAMA_IDS = new Set(CURATED_OLLAMA_MODELS.map((m) => m.ollamaId || m.id));

function normalizeModelId(modelId) {
  // Ollama often reports installed models as "name:tag" (e.g. llama3:latest).
  // We normalize to base name so curated entries can match installed tagged variants.
  return String(modelId || '').split(':')[0];
}

function prettifyEndpointModelLabel(rawId) {
  const raw = String(rawId || '').trim();
  if (!raw) return 'model';
  let value = raw.includes('\\') ? raw.split('\\').pop() : raw;
  value = value.includes('/') ? value.split('/').pop() : value;
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

  const catalog = CURATED_OLLAMA_MODELS.map((entry) => {
    const entryNeedle = normalizeCatalogNeedle(`${entry.id} ${entry.ollamaId || ''} ${entry.label}`);
    let matchedRemote = null;
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

  const combined = [...catalog, ...localExtras, ...extras];
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
    if (provider === 'openai') return 'gpt-4o-mini';
    if (provider === 'grok') return 'grok-3-mini';
    if (provider === 'groq') return 'llama-3.3-70b-versatile';
    if (provider === 'openrouter') return 'meta-llama/llama-3.3-70b-instruct:free';
    if (provider === 'gemini') return 'gemini-2.5-flash';
    if (provider === 'cerebras') return 'llama-3.3-70b';
    if (provider === 'gpuaas') return config.openAIModel || 'model';
    return config.openAIModel || 'model.gguf';
  }
  if (provider === 'claude') {
    const preferred = model && model !== 'auto' ? model : config.openAIModel;
    if (preferred && preferred !== 'auto') return preferred;
    return 'claude-3-5-sonnet-latest';
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
    const providerFallbackModel = provider === 'openai'
      ? 'gpt-4o-mini'
      : provider === 'grok'
      ? 'grok-3-mini'
      : provider === 'groq'
      ? 'llama-3.3-70b-versatile'
      : provider === 'openrouter'
      ? 'meta-llama/llama-3.3-70b-instruct:free'
      : provider === 'gemini'
      ? 'gemini-2.5-flash'
      : provider === 'cerebras'
      ? 'llama-3.3-70b'
      : provider === 'gpuaas'
      ? null   // no meaningful default - user must specify
      : provider === 'vllm'
      ? null   // vLLM lists its own models remotely; user points at their server
      : config.openAIModel;

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
      id: config.openAIModel || 'claude-3-5-sonnet-latest',
      label: prettifyEndpointModelLabel(config.openAIModel || 'claude-3-5-sonnet-latest'),
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
    CURATED_OLLAMA_MODELS.flatMap((m) => [
      normalizeModelId(m.id),
      normalizeModelId(m.ollamaId || m.id)
    ])
  );
  const curated = CURATED_OLLAMA_MODELS.map((model) => {
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
