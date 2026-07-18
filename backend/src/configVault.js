// backend/src/configVault.js
// Config Vault: cited RAG over a local folder of network / homelab config files.
// This is the local-first superpower a cloud assistant can never offer - it aims
// semantic retrieval at the one corpus that must never leave the machine: your
// own device configs. It REUSES the Recall Orb's embedding path (same Ollama
// model pick, same in-process cache) and cosine similarity, so there is exactly
// one vector stack, not two. Reads are jailed to the chosen root, chunking is
// line-aware so every hit cites a real file:line range.

import { stat, readdir, readFile } from 'node:fs/promises';
import { resolve, normalize, sep, relative, join } from 'node:path';
import { cosine } from './recall.js';
import { readVault, writeVault, clearVault } from './storage/configVaultStore.js';

const MAX_FILE_BYTES = 512 * 1024;   // skip any single file larger than this
const MAX_FILES = 600;               // cap the corpus so indexing can never run away
const MAX_CHUNKS = 20000;            // hard ceiling on total chunks (mirrors recall's MAX_DOCS) so a
                                     // folder of large files can never trigger an unbounded embed storm
const CHUNK_CHARS = 900;             // configs: keep stanzas (an interface {} block) together
const EMBED_CONCURRENCY = 4;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', 'build', 'out',
  'coverage', '.cache', '.turbo', '.venv', '__pycache__', 'vendor'
]);

// Obvious binary extensions never worth embedding. Extensionless files (very
// common for configs) are allowed through and checked for null bytes instead.
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tiff', 'tif', 'heic',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'jar', 'wasm', 'node',
  'dmg', 'iso', 'img', 'pkg', 'deb', 'rpm',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'db', 'sqlite', 'sqlite3', 'psd', 'ai', 'sketch', 'pyc', 'pyo'
]);

function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

async function mapLimit(items, limit, mapper) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await mapper(items[index], index);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) workers.push(worker());
  await Promise.all(workers);
}

// Line-aware chunking: group whole lines into ~CHUNK_CHARS windows and track the
// 1-based start/end line of each chunk so a retrieval hit can cite file:line.
function chunkByLines(content, maxChars = CHUNK_CHARS) {
  const lines = String(content || '').split('\n');
  const chunks = [];
  let buf = [];
  let bufLen = 0;
  let startLine = 1;
  for (let i = 0; i < lines.length; i += 1) {
    buf.push(lines[i]);
    bufLen += lines[i].length + 1;
    if (bufLen >= maxChars) {
      const text = buf.join('\n').trim();
      if (text) chunks.push({ text, startLine, endLine: i + 1 });
      buf = [];
      bufLen = 0;
      startLine = i + 2;
    }
  }
  if (buf.length) {
    const text = buf.join('\n').trim();
    if (text) chunks.push({ text, startLine, endLine: lines.length });
  }
  return chunks;
}

export function createConfigVault({ recall, vaultStorePath }) {
  // Jail an absolute path to the chosen root; reject anything that escapes it.
  function jailRoot(inputRoot) {
    const cleaned = normalize(String(inputRoot || '').replace(/\0/g, ''));
    const root = resolve(cleaned);
    return root;
  }

  async function walk(root) {
    const out = [];
    async function recurse(dir) {
      if (out.length >= MAX_FILES) return;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (out.length >= MAX_FILES) break;
        if (entry.name.startsWith('.')) continue; // skip dotfiles/dotdirs
        const abs = join(dir, entry.name);
        // Keep every walked path inside the root (defense in depth vs symlinks).
        if (abs !== root && !abs.startsWith(root + sep)) continue;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          await recurse(abs);
        } else if (entry.isFile()) {
          if (BINARY_EXT.has(extOf(entry.name))) continue;
          out.push(abs);
        }
      }
    }
    await recurse(root);
    return out;
  }

  async function index(inputRoot) {
    const root = jailRoot(inputRoot);
    const st = await stat(root).catch(() => null);
    if (!st || !st.isDirectory()) {
      throw new Error(`Config Vault path is not a folder: ${inputRoot}`);
    }
    // Reuse the Recall Orb embedding model pick (throws if none is available).
    const embedModel = await recall.ensureModel();

    const files = await walk(root);
    const chunks = [];
    let indexedFiles = 0;
    for (const abs of files) {
      let content;
      try {
        const fst = await stat(abs);
        if (fst.size > MAX_FILE_BYTES) continue;
        content = await readFile(abs, 'utf8');
      } catch { continue; }
      let looksBinary = false;
      for (let k = 0; k < Math.min(content.length, 8192); k += 1) { if (content.charCodeAt(k) === 0) { looksBinary = true; break; } }
      if (looksBinary) continue; // a NUL byte means binary - skip
      const relPath = relative(root, abs);
      const fileChunks = chunkByLines(content);
      if (fileChunks.length) indexedFiles += 1;
      for (const c of fileChunks) {
        if (chunks.length >= MAX_CHUNKS) break;
        chunks.push({ id: `${relPath}#${c.startLine}`, relPath, startLine: c.startLine, endLine: c.endLine, text: c.text });
      }
      if (chunks.length >= MAX_CHUNKS) break; // chunk budget exhausted - stop walking further files
    }
    const truncated = chunks.length >= MAX_CHUNKS;

    await mapLimit(chunks, EMBED_CONCURRENCY, async (chunk) => {
      try { chunk.vector = await recall.embedText(chunk.text); }
      catch { chunk.vector = null; }
    });
    const embedded = chunks.filter((c) => Array.isArray(c.vector) && c.vector.length);

    await writeVault(vaultStorePath, {
      root,
      builtAt: new Date().toISOString(),
      embedModel,
      fileCount: indexedFiles,
      chunks: embedded
    });

    return { ok: true, root, embedModel, fileCount: indexedFiles, chunkCount: embedded.length, truncated };
  }

  async function query(queryText, limit = 6) {
    const store = await readVault(vaultStorePath);
    if (!store.chunks.length) {
      return { ok: true, root: store.root, results: [] };
    }
    const topK = Math.min(Math.max(1, Number(limit) || 6), 20);
    let qvec;
    try {
      await recall.ensureModel();
      // The index is only comparable if it was built with the same embedding model.
      // A different model yields different-dimensionality vectors, which cosine would
      // silently score as 0, returning arbitrary chunks as if they were relevant. Refuse
      // instead, so the user re-indexes rather than getting confidently-wrong citations.
      const activeModel = recall.getEmbedModel ? recall.getEmbedModel() : null;
      if (store.embedModel && activeModel && activeModel !== store.embedModel) {
        return { ok: false, error: `Vault was indexed with "${store.embedModel}" but "${activeModel}" is active now. Re-index the Config Vault.`, results: [] };
      }
      qvec = await recall.embedText(String(queryText || ''));
    } catch {
      return { ok: false, error: 'No local embedding model is available.', results: [] };
    }
    const scored = [];
    for (const c of store.chunks) {
      if (!Array.isArray(c.vector) || c.vector.length !== qvec.length) continue; // dimension mismatch - skip
      scored.push({ score: cosine(qvec, c.vector), relPath: c.relPath, startLine: c.startLine, endLine: c.endLine, text: c.text });
    }
    if (scored.length === 0) {
      return { ok: false, error: 'Vault index is incompatible with the current embedding model. Re-index required.', results: [] };
    }
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, topK).map((r) => ({
      score: Math.round(r.score * 1000) / 1000,
      relPath: r.relPath,
      startLine: r.startLine,
      endLine: r.endLine,
      citation: `${r.relPath}:${r.startLine}-${r.endLine}`,
      snippet: r.text.length > 700 ? `${r.text.slice(0, 700)}…` : r.text
    }));
    return { ok: true, root: store.root, embedModel: store.embedModel, results };
  }

  async function status() {
    const store = await readVault(vaultStorePath);
    return {
      ok: true,
      root: store.root || '',
      builtAt: store.builtAt || null,
      embedModel: store.embedModel || null,
      fileCount: store.fileCount || 0,
      chunkCount: Array.isArray(store.chunks) ? store.chunks.length : 0
    };
  }

  async function clear() {
    await clearVault(vaultStorePath);
    return { ok: true };
  }

  return { index, query, status, clear };
}
