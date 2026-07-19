// backend/src/recall.js
// Recall Orb: local semantic recall over the user's own history. Builds a corpus
// from past chats (chats.json) and IntelLedger signals (intelledger.json), embeds
// every document with a local Ollama model, and ranks them against a query by
// cosine similarity. Everything runs on the local machine - no cloud egress.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const PREFERRED_EMBED_MODEL = 'nomic-embed-text';
const CHUNK_CHARS = 600;
const DEFAULT_TOP_K = 6;
// Safety caps so a huge history never turns the first query into a multi-minute
// embed storm. Most recent chats are preferred when the cap is hit.
const MAX_DOCS = 600;
const EMBED_CONCURRENCY = 4;
// Raised from 30s: the first embed includes a cold load of the embedding model,
// which can breach 30s on a slow disk and silently fail the first Recall query.
const EMBED_TIMEOUT_MS = 90000;

// Contradiction detection ("Your Past Self Disagrees"). A small local chat model
// judges whether a current decision conflicts with a similar past one. All caps
// are deliberate so a scan can never turn into a long LLM storm.
const DEFAULT_JUDGE_MODEL = 'qwen2.5:0.5b';
const CONTRA_SIM_THRESHOLD = 0.55; // minimum cosine similarity to bother judging
const CONTRA_NEAR_DUPLICATE = 0.985; // above this it is almost certainly the same sentence
const CONTRA_TOP_K = 3; // at most this many past candidates per statement
const CONTRA_MAX_JUDGE_CALLS = 6; // hard cap on LLM judge calls per request
// Raised from 30s: the judge model is user-selectable and its first call includes a
// cold load; a larger judge on CPU can exceed 30s and be killed mid-verdict.
const CHAT_TIMEOUT_MS = 120000;

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

// Common words that carry no subject meaning, so they never count as a shared
// topic between two statements.
const CONTRA_STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'their', 'there', 'these', 'those', 'which',
  'while', 'would', 'could', 'should', 'shall', 'going', 'gonna', 'still', 'instead',
  'because', 'before', 'being', 'other', 'another', 'thing', 'things', 'stuff',
  'with', 'from', 'into', 'that', 'this', 'they', 'them', 'then', 'than', 'have',
  'will', 'want', 'need', 'used', 'using', 'make', 'made', 'take', 'plan', 'plans',
  'decided', 'decide', 'agreed', 'agree', 'chose', 'choose', 'now', 'our', 'your'
]);

// Substantive tokens (length >= 4, not a stopword) that describe what a statement
// is about. Two statements can only reverse the same decision if they share one.
function contentTokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !CONTRA_STOPWORDS.has(token))
  );
}

function sharesContentToken(a, b) {
  const setA = contentTokens(a);
  if (setA.size === 0) return false;
  for (const token of contentTokens(b)) {
    if (setA.has(token)) return true;
  }
  return false;
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

// Run an async mapper over items with a small fixed concurrency so the first
// query does not fire hundreds of simultaneous requests at Ollama.
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

export function createRecall({ config = {}, chatStorePath, intelLedgerStorePath } = {}) {
  const ollamaBaseUrl = String(config.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');

  // Cached across queries for the life of the process.
  let chosenModel = null;
  let chosenJudgeModel = null;
  const embedCache = new Map(); // sha1(text) -> number[]

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

  // Pick an embedding model once: try the preferred embed model, then fall back
  // to the first chat model reported by /api/tags. Cached after the first pick.
  async function ensureModel() {
    if (chosenModel) return chosenModel;
    try {
      await embedOnce(PREFERRED_EMBED_MODEL, 'probe');
      chosenModel = PREFERRED_EMBED_MODEL;
      return chosenModel;
    } catch {
      /* preferred model unavailable - fall through to the tag list */
    }
    const tags = await listTagModels();
    for (const name of tags) {
      try {
        await embedOnce(name, 'probe');
        chosenModel = name;
        return chosenModel;
      } catch {
        /* try the next model */
      }
    }
    throw new Error('no local embedding model is available');
  }

  async function embedText(text) {
    const key = sha1(text);
    const cached = embedCache.get(key);
    if (cached) return cached;
    const vector = await embedOnce(chosenModel, text);
    embedCache.set(key, vector);
    return vector;
  }

  // Assemble the corpus of documents from chats + ledger signals.
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
            sessionId: '',
            title,
            snippet: chunk
          });
          if (docs.length >= MAX_DOCS) break;
        }
        if (docs.length >= MAX_DOCS) break;
      }
      if (docs.length >= MAX_DOCS) break;
    }

    if (docs.length < MAX_DOCS) {
      const ledgerStore = await readJsonSafe(intelLedgerStorePath, { signals: [] });
      const signals = Array.isArray(ledgerStore?.signals) ? ledgerStore.signals : [];
      for (const signal of signals) {
        const value = String(signal?.value || signal?.quote || '').trim();
        if (!value) continue;
        const title = String(signal?.signal_type || 'signal');
        const chunks = chunkText(value);
        for (const chunk of chunks) {
          docs.push({
            text: `${title}\n${chunk}`,
            source: 'ledger',
            chatId: '',
            sessionId: signal?.session_id || '',
            title,
            snippet: chunk
          });
          if (docs.length >= MAX_DOCS) break;
        }
        if (docs.length >= MAX_DOCS) break;
      }
    }

    return docs;
  }

  // Main entry point. Returns { ok:true, model, results } on success or
  // { ok:false, reason } when Ollama is unreachable or nothing can be embedded.
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
        chatId: entry.doc.chatId,
        sessionId: entry.doc.sessionId
      }));

    if (ranked.length === 0 && embedFailures > 0) {
      return { ok: false, reason: 'embedding failed for every document' };
    }

    return { ok: true, model: chosenModel, results: ranked };
  }

  // Pick the chat model that judges conflicts. Prefer an explicit model, then the
  // small default if installed, then any non-embedding model reported by /api/tags.
  async function ensureJudgeModel(preferred) {
    // Precedence: explicit request model > config/env override > small default.
    // A stronger installed model (for example gemma3:12b) judges reaffirmations
    // far more reliably than the 0.5b default, at the cost of higher latency.
    const wanted = String(
      preferred || config.contradictionModel || process.env.MIRABILIS_CONTRADICTION_MODEL || ''
    ).trim();
    if (wanted) return wanted;
    if (chosenJudgeModel) return chosenJudgeModel;
    const tags = await listTagModels();
    if (tags.includes(DEFAULT_JUDGE_MODEL)) {
      chosenJudgeModel = DEFAULT_JUDGE_MODEL;
      return chosenJudgeModel;
    }
    const chatModel = tags.find((name) => !/embed/i.test(String(name)));
    chosenJudgeModel = chatModel || DEFAULT_JUDGE_MODEL;
    return chosenJudgeModel;
  }

  // Pull the first {...} block out of a model reply and read the verdict leniently.
  function parseJudgeVerdict(content) {
    const raw = String(content || '');
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const obj = JSON.parse(match[0]);
        return {
          conflict: obj.conflict === true || String(obj.conflict).toLowerCase() === 'true',
          why: String(obj.why || '').replace(/\s+/g, ' ').trim().slice(0, 200)
        };
      } catch {
        /* fall through to keyword scan */
      }
    }
    // Last resort: a bare yes/true anywhere in the text counts as a conflict.
    if (/\b(conflict"?\s*:\s*true|yes|contradict|superseded|changed)\b/i.test(raw)) {
      return { conflict: true, why: '' };
    }
    return { conflict: false, why: '' };
  }

  // Ask the local chat model whether two statements express a reversed decision.
  async function judgeConflict(model, current, past) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    try {
      const res = await fetch(`${ollamaBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          options: { temperature: 0 },
          messages: [
            {
              role: 'system',
              content: 'You detect when a person reversed a past decision. Reply with strict JSON only.'
            },
            {
              role: 'user',
              content: [
                'Answer true only when the newer statement chooses a DIFFERENT option than the older one for the same subject.',
                'Example: past "use PostgreSQL", now "use MongoDB instead" -> true. Past "use PostgreSQL", now "keep using PostgreSQL" -> false.',
                `Past: "${past}"`,
                `Now: "${current}"`,
                'Strict JSON: {"conflict": true|false, "why": "<short>"}'
              ].join('\n')
            }
          ]
        }),
        signal: controller.signal
      });
      if (!res.ok) return null;
      const payload = await res.json();
      const content = payload?.message?.content ?? payload?.response ?? '';
      return parseJudgeVerdict(content);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // Given a set of current decision/commitment statements, find the ones that
  // contradict or supersede something in the user's own past chats or ledger.
  // Resilient by design: any failure (Ollama down, no model) yields no conflicts.
  async function findContradictions(statements, opts = {}) {
    const stmts = (Array.isArray(statements) ? statements : [])
      .map((item) => (typeof item === 'string' ? item : String(item?.value || item?.text || '')).replace(/\s+/g, ' ').trim())
      .filter((item) => item.length >= 8);
    // De-duplicate while preserving order.
    const seenStmt = new Set();
    const uniqueStmts = [];
    for (const stmt of stmts) {
      const key = stmt.toLowerCase();
      if (seenStmt.has(key)) continue;
      seenStmt.add(key);
      uniqueStmts.push(stmt);
    }
    if (uniqueStmts.length === 0) return { ok: true, model: null, conflicts: [] };

    try {
      await ensureModel();
    } catch (error) {
      return { ok: false, reason: `embedding model unavailable: ${error.message}`, conflicts: [] };
    }

    let docs;
    try {
      docs = await buildCorpus();
    } catch (error) {
      return { ok: false, reason: `failed to read history: ${error.message}`, conflicts: [] };
    }
    if (docs.length === 0) return { ok: true, model: chosenModel, conflicts: [] };

    // Embed the corpus once; the cache keeps this cheap on later requests.
    const docVectors = await mapLimit(docs, EMBED_CONCURRENCY, async (doc) => {
      try {
        return await embedText(doc.text);
      } catch {
        return null;
      }
    });

    const judgeModel = await ensureJudgeModel(opts.model);
    const simThreshold = Number(opts.threshold) || CONTRA_SIM_THRESHOLD;
    const topK = Math.max(1, Math.min(Number(opts.topK) || CONTRA_TOP_K, 5));
    const maxJudgeCalls = Math.max(1, Math.min(Number(opts.maxJudgeCalls) || CONTRA_MAX_JUDGE_CALLS, 12));

    const conflicts = [];
    let judgeCalls = 0;

    for (const statement of uniqueStmts) {
      if (judgeCalls >= maxJudgeCalls) break;

      let stmtVector;
      try {
        stmtVector = await embedText(statement);
      } catch {
        continue;
      }

      const ranked = docs
        .map((doc, index) => ({ doc, score: docVectors[index] ? cosine(stmtVector, docVectors[index]) : 0 }))
        // Skip near-identical text: that is the same sentence, not a conflict.
        .filter((entry) => entry.score >= simThreshold && entry.score < CONTRA_NEAR_DUPLICATE)
        // Require a shared subject word so unrelated topics never reach the judge.
        // This keeps the small local model honest and bounds the judge-call count,
        // even when only a general chat model is available for embeddings.
        .filter((entry) => sharesContentToken(statement, entry.doc.snippet))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      for (const entry of ranked) {
        if (judgeCalls >= maxJudgeCalls) break;
        judgeCalls += 1;
        const verdict = await judgeConflict(judgeModel, statement, entry.doc.snippet);
        if (verdict && verdict.conflict) {
          conflicts.push({
            current: statement,
            past: {
              title: entry.doc.title,
              snippet: entry.doc.snippet,
              source: entry.doc.source,
              chatId: entry.doc.chatId,
              sessionId: entry.doc.sessionId
            },
            why: verdict.why || 'This appears to reverse an earlier decision.',
            score: Number(entry.score.toFixed(4))
          });
          break; // one flagged conflict per statement is enough
        }
      }
    }

    return { ok: true, model: judgeModel, embedModel: chosenModel, conflicts };
  }

  // embedText/ensureModel are exposed so the Config Vault reuses this exact
  // embedding path (same Ollama model pick and the same in-process cache) rather
  // than standing up a second, parallel vector stack.
  return { query, findContradictions, embedText, ensureModel, getEmbedModel: () => chosenModel };
}

// Module-level similarity + chunking, shared with the Config Vault so there is
// one canonical implementation of each.
export { cosine, chunkText };
