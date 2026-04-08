import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamOllamaChat, listOllamaModels } from './providers/ollama.js';
import { streamOpenAICompatibleChat, listOpenAICompatibleModels } from './providers/openaiCompatible.js';

const CURATED_OLLAMA_MODELS = [
  // Lightweight models — run well on most hardware
  { id: 'llama3',         label: 'Llama 3',           group: 'Lightweight', ollamaId: 'llama3',           size: '4.7 GB' },
  { id: 'llama3.1',       label: 'Llama 3.1',         group: 'Lightweight', ollamaId: 'llama3.1',         size: '4.7 GB' },
  { id: 'mistral',        label: 'Mistral 7B',         group: 'Lightweight', ollamaId: 'mistral',          size: '4.1 GB' },
  { id: 'qwen2.5',        label: 'Qwen 2.5',           group: 'Lightweight', ollamaId: 'qwen2.5',          size: '4.7 GB' },
  { id: 'gemma3',         label: 'Gemma 3',            group: 'Lightweight', ollamaId: 'gemma3',           size: '3.3 GB' },
  { id: 'phi4',           label: 'Phi-4',              group: 'Lightweight', ollamaId: 'phi4',             size: '9.1 GB' },
  // Powerful models — need more RAM/VRAM
  { id: 'qwen3',          label: 'Qwen 3',             group: 'Powerful',    ollamaId: 'qwen3',            size: '5.2 GB' },
  { id: 'deepseek-r1',    label: 'DeepSeek R1',        group: 'Powerful',    ollamaId: 'deepseek-r1',      size: '4.7 GB' },
  { id: 'deepseek-v3',    label: 'DeepSeek V3',        group: 'Powerful',    ollamaId: 'deepseek-v3',      size: '404 GB' },
  { id: 'llama3.3',       label: 'Llama 3.3 70B',      group: 'Powerful',    ollamaId: 'llama3.3',         size: '43 GB' },
  { id: 'mistral-large',  label: 'Mistral Large 3',    group: 'Powerful',    ollamaId: 'mistral-large',    size: '69 GB' },
  { id: 'mixtral',        label: 'Mixtral 8x22B',      group: 'Powerful',    ollamaId: 'mixtral:8x22b',    size: '80 GB' },
  { id: 'llama4',         label: 'Llama 4 Scout',      group: 'Powerful',    ollamaId: 'llama4:scout',     size: '109 GB' },
  { id: 'jamba',          label: 'Jamba (AI21)',       group: 'Powerful',    ollamaId: 'jamba',            size: '52 GB' },
  { id: 'dbrx',           label: 'DBRX',               group: 'Powerful',    ollamaId: 'dbrx',             size: '74 GB' },
  // Uncensored / less-restricted community models
  { id: 'dolphin3',                label: 'Dolphin 3.0',                      group: 'Uncensored', ollamaId: 'dolphin3',                      size: '4.7 GB' },
  { id: 'dolphin-mixtral',         label: 'Mixtral 8x7B (Uncensored)',        group: 'Uncensored', ollamaId: 'dolphin-mixtral:8x7b',          size: '26 GB'  },
  { id: 'deepseek-r1-abliterated', label: 'DeepSeek R1 Distill (Abliterated)', group: 'Uncensored', ollamaId: 'deepseek-r1-abliterated',       size: '4.7 GB' },
  { id: 'qwen3.5-uncensored',      label: 'Qwen 3.5 Uncensored',             group: 'Uncensored', ollamaId: 'qwen3.5-uncensored',            size: '4.7 GB' },
  { id: 'llama4.1',                label: 'Llama 4.1 Surge',                 group: 'Uncensored', ollamaId: 'llama4.1:surge',                size: '55 GB'  },
];

// All valid pull targets — used by the pull endpoint to whitelist requests
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

    for (const [remoteId, remote] of remoteById.entries()) {
      const remoteNeedle = normalizeCatalogNeedle(remoteId);
      const base = normalizeCatalogNeedle(normalizeModelId(remoteId));
      if (
        remoteNeedle.includes(normalizeCatalogNeedle(normalizeModelId(entry.id))) ||
        remoteNeedle.includes(normalizeCatalogNeedle(normalizeModelId(entry.ollamaId || ''))) ||
        (entryNeedle && base && entryNeedle.includes(base))
      ) {
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

    return {
      ...entry,
      id: entry.id,
      label: entry.label,
      available: false,
      selected: false,
      paramSize: null
    };
  });

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

export function getEffectiveModel({ provider, model, config }) {
  if (model) {
    return model;
  }
  if (provider === 'openai-compatible') return config.openAIModel;
  if (provider === 'koboldcpp') return config.koboldModel || config.openAIModel;
  return config.ollamaModel;
}

export async function listModels(config, provider = config.aiProvider, options = {}) {
  const overrideBaseUrl = typeof options?.overrideBaseUrl === 'string' ? options.overrideBaseUrl.trim() : '';
  const overrideApiKey = typeof options?.overrideApiKey === 'string' ? options.overrideApiKey.trim() : undefined;

  if (provider === 'openai-compatible') {
    const baseUrl = overrideBaseUrl || config.openAIBaseUrl;
    const apiKey = overrideApiKey !== undefined ? overrideApiKey : config.openAIApiKey;
    const remote = await listOpenAICompatibleModels({ baseUrl, apiKey }).catch(() => []);
    const locals = await listLocalGgufModels();
    if (remote.length > 0) {
      const selectedId = config.openAIModel;
      return buildEndpointCatalog({ remoteModels: remote, selectedModelId: selectedId, localModels: locals });
    }
    if (locals.length > 0) {
      return buildEndpointCatalog({ remoteModels: [], selectedModelId: config.openAIModel, localModels: locals });
    }
    return [{
      id: config.openAIModel,
      label: prettifyEndpointModelLabel(config.openAIModel),
      group: 'Configured endpoint',
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

  const discoveredModels = await listOllamaModels(config.ollamaBaseUrl);
  const discoveredSet = new Set(discoveredModels.map((m) => m.name));
  const discoveredBaseSet = new Set(discoveredModels.map((m) => normalizeModelId(m.name)));
  const paramSizeMap = {};
  for (const m of discoveredModels) {
    paramSizeMap[normalizeModelId(m.name)] = m.paramSize;
  }
  const curatedBaseSet = new Set(
    CURATED_OLLAMA_MODELS.flatMap((m) => [
      normalizeModelId(m.id),
      normalizeModelId(m.ollamaId || m.id)
    ])
  );
  const curated = CURATED_OLLAMA_MODELS.map((model) => {
    const pullId = model.ollamaId || model.id;
    const isAvailable =
      discoveredSet.has(model.id) ||
      discoveredSet.has(pullId) ||
      discoveredBaseSet.has(normalizeModelId(model.id)) ||
      discoveredBaseSet.has(normalizeModelId(pullId));
    const paramSize =
      paramSizeMap[normalizeModelId(model.id)] ||
      paramSizeMap[normalizeModelId(pullId)] ||
      null;
    return {
      ...model,
      available: isAvailable,
      selected: normalizeModelId(model.id) === normalizeModelId(config.ollamaModel),
      paramSize
    };
  });

  const extraModels = discoveredModels
    .filter(({ name }) => !curatedBaseSet.has(normalizeModelId(name)))
    .map(({ name, paramSize }) => ({
      id: name,
      label: name,
      group: 'Installed locally',
      available: true,
      selected: name === config.ollamaModel,
      paramSize: paramSize || null
    }));

  return [...curated, ...extraModels];
}

export async function streamWithProvider({ provider, model, messages, config, signal, onToken, overrideBaseUrl, overrideApiKey }) {
  if (provider === 'openai-compatible') {
    return streamOpenAICompatibleChat({
      baseUrl: overrideBaseUrl || config.openAIBaseUrl,
      apiKey: overrideApiKey !== undefined ? overrideApiKey : config.openAIApiKey,
      model,
      messages,
      signal,
      onToken
    });
  }

  if (provider === 'koboldcpp') {
    return streamOpenAICompatibleChat({
      baseUrl: overrideBaseUrl || config.koboldBaseUrl,
      apiKey: overrideApiKey !== undefined ? overrideApiKey : '',
      model,
      messages,
      signal,
      onToken
    });
  }

  return streamOllamaChat({
    baseUrl: config.ollamaBaseUrl,
    model,
    messages,
    signal,
    onToken
  });
}
