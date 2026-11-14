// Local semantic recall over past chats, embedded with a local Ollama model and
// ranked by cosine similarity.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const PREFERRED_EMBED_MODEL = 'nomic-embed-text';
const CHUNK_CHARS = 600;
const DEFAULT_TOP_K = 6;
// Caps keep the first query on a large history from taking minutes; newest chats win.
const MAX_DOCS = 600;
const EMBED_CONCURRENCY = 4;
// Covers a cold load of the embedding model on a slow disk.
const EMBED_TIMEOUT_MS = 90000;

function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

function chunkText(text, size = CHUNK_CHARS) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks = [];
  for (let i = 0; i < clean.length; i += size) {
    chunks.push(clean.slice(i, i + size));
  }
  return chunks;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function readJsonSafe(filePath, fallback) {
  if (!filePath) return fallback;
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// Bounded concurrency so a cold query does not flood Ollama.
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

export function createRecall({ config = {}, chatStorePath } = {}) {
  const ollamaBaseUrl = String(config.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');

  // Cached across queries for the life of the process.
  let chosenModel = null;
  const embedCache = new Map(); // sha1(text) -> number[]
  const EMBED_CACHE_MAX = 2000; // LRU bound

  async function embedOnce(model, prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
      const res = await fetch(`${ollamaBaseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt }),
        signal: controller.signal
      });
      if (!res.ok) {
        throw new Error(`embeddings request failed (${res.status})`);
      }
      const payload = await res.json();
      const vector = payload?.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error('embeddings response had no vector');
      }
      return vector;
    } finally {
      clearTimeout(timer);
    }
  }

  async function listTagModels() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
      const res = await fetch(`${ollamaBaseUrl}/api/tags`, { signal: controller.signal });
      if (!res.ok) return [];
      const payload = await res.json();
      const models = Array.isArray(payload?.models) ? payload.models : [];
      return models.map((m) => m?.name).filter(Boolean);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  // Only purpose-built embedders qualify. Chat models also answer /api/embeddings,
  // but they are far slower, embed worse and evict the user's chat model.
  const EMBED_NAME_RE = /embed|bge|gte|minilm|e5|nomic/i;

  async function ensureModel() {
    if (chosenModel) return chosenModel;
    try {
      await embedOnce(PREFERRED_EMBED_MODEL, 'probe');
      chosenModel = PREFERRED_EMBED_MODEL;
      return chosenModel;
    } catch {
      /* preferred model unavailable: look for another embedder */
    }
    const tags = await listTagModels();
    const candidates = tags.filter((name) => EMBED_NAME_RE.test(String(name)));
    for (const name of candidates) {
      try {
        await embedOnce(name, 'probe');
        chosenModel = name;
        return chosenModel;
      } catch {
        /* try the next embedding model */
      }
    }
    throw new Error(
      `No embedding model is installed. Run: ollama pull ${PREFERRED_EMBED_MODEL}`
    );
  }

  async function embedText(text) {
    const key = sha1(text);
    const cached = embedCache.get(key);
    if (cached) {
      embedCache.delete(key); embedCache.set(key, cached); // mark most-recent
      return cached;
    }
    const vector = await embedOnce(chosenModel, text);
    embedCache.set(key, vector);
    if (embedCache.size > EMBED_CACHE_MAX) {
      const oldest = embedCache.keys().next().value; // Map keeps insertion order
      if (oldest !== undefined) embedCache.delete(oldest);
    }
    return vector;
  }

  async function buildCorpus() {
    const docs = [];

    const chatStore = await readJsonSafe(chatStorePath, { chats: [] });
    const chats = Array.isArray(chatStore?.chats) ? chatStore.chats : [];
    // Newest chats first so the MAX_DOCS cap keeps the most recent history.
    const sortedChats = [...chats].sort(
      (a, b) => new Date(b?.updatedAt || 0).getTime() - new Date(a?.updatedAt || 0).getTime()
    );
    for (const chat of sortedChats) {
      const title = String(chat?.title || 'Untitled chat');
      const messages = Array.isArray(chat?.messages) ? chat.messages : [];
      for (const message of messages) {
        if (message?.role !== 'user' && message?.role !== 'assistant') continue;
        const chunks = chunkText(message?.content);
        for (const chunk of chunks) {
          docs.push({
            text: `${title}\n${chunk}`,
            source: 'chat',
            chatId: chat?.id || '',
            title,
            snippet: chunk
          });
          if (docs.length >= MAX_DOCS) break;
        }
        if (docs.length >= MAX_DOCS) break;
      }
      if (docs.length >= MAX_DOCS) break;
    }

    return docs;
  }

  // Returns { ok:true, model, results } or { ok:false, reason }.
  async function query(queryText, limit = DEFAULT_TOP_K) {
    const term = String(queryText || '').trim();
    if (!term) return { ok: false, reason: 'query is empty' };

    const topK = Math.max(1, Math.min(Number(limit) || DEFAULT_TOP_K, 50));

    try {
      await ensureModel();
    } catch (error) {
      return { ok: false, reason: `embedding model unavailable: ${error.message}` };
    }

    let queryVector;
    try {
      queryVector = await embedText(term);
    } catch (error) {
      return { ok: false, reason: `failed to embed query: ${error.message}` };
    }

    let docs;
    try {
      docs = await buildCorpus();
    } catch (error) {
      return { ok: false, reason: `failed to read history: ${error.message}` };
    }
    if (docs.length === 0) {
      return { ok: true, model: chosenModel, results: [] };
    }

    let embedFailures = 0;
    const scored = await mapLimit(docs, EMBED_CONCURRENCY, async (doc) => {
      try {
        const vector = await embedText(doc.text);
        return { doc, score: cosine(queryVector, vector) };
      } catch {
        embedFailures += 1;
        return null;
      }
    });

    const ranked = scored
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((entry) => ({
        score: Number(entry.score.toFixed(4)),
        source: entry.doc.source,
        title: entry.doc.title,
        snippet: entry.doc.snippet,
        chatId: entry.doc.chatId
      }));

    if (ranked.length === 0 && embedFailures > 0) {
      return { ok: false, reason: 'embedding failed for every document' };
    }

    return { ok: true, model: chosenModel, results: ranked };
  }

  // Exposed so the Config Vault shares this model pick and embed cache.
  return { query, embedText, ensureModel, getEmbedModel: () => chosenModel };
}

// Shared with the Config Vault.
export { cosine, chunkText };
