// @ts-check
// Text attachments (configs, source, logs) are read into the prompt at send time.
// Binary files and images are left alone; images go through the vision path.

import { open } from 'node:fs/promises';
import path from 'node:path';

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'config', 'xml', 'html', 'css', 'scss', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go',
  'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'java', 'kt', 'swift', 'cs', 'php', 'pl', 'lua', 'sql', 'sh',
  'bash', 'zsh', 'fish', 'ps1', 'bat', 'mk', 'cmake', 'gradle', 'proto', 'graphql', 'tf', 'hcl',
  'j2', 'jinja', 'set', 'junos', 'ios', 'eos', 'cisco', 'diff', 'patch', 'env', 'properties', 'rst', 'tex'
]);
const TEXT_NAMES = new Set(['makefile', 'dockerfile', 'license', 'readme', 'cargo.lock', 'gemfile', 'procfile']);
const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|toml|javascript|x-sh|x-shellscript|sql|x-ndjson))/i;

/** Hard ceiling on what is read from disk for one file. */
const READ_LIMIT_BYTES = 2 * 1024 * 1024;

export function isTextAttachment(att) {
  if (!att) return false;
  const name = String(att.name || '').toLowerCase();
  const ext = name.includes('.') ? (name.split('.').pop() || '') : '';
  if (/^image\//i.test(att.mimeType || '')) return false;
  return TEXT_MIME.test(att.mimeType || '') || TEXT_EXTENSIONS.has(ext) || TEXT_NAMES.has(name);
}

/** NUL bytes in the first 8 KB mean binary, whatever the extension says. */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

/**
 * Keep the head and tail of a long file, with a note saying which lines were sent.
 * @param {string} text
 * @param {number} maxChars
 */
export function clipText(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false, note: '' };
  const lines = text.split('\n');
  const headBudget = Math.floor(maxChars * 0.7);
  const tailBudget = maxChars - headBudget;
  let headEnd = 0;
  for (let used = 0; headEnd < lines.length && used + lines[headEnd].length + 1 <= headBudget; headEnd += 1) {
    used += lines[headEnd].length + 1;
  }
  let tailStart = lines.length;
  for (let used = 0; tailStart > headEnd && used + lines[tailStart - 1].length + 1 <= tailBudget; tailStart -= 1) {
    used += lines[tailStart - 1].length + 1;
  }
  // One huge line (minified file): cut by characters instead.
  if (headEnd === 0) {
    return {
      text: `${text.slice(0, headBudget)}\n[...]\n${text.slice(-tailBudget)}`,
      truncated: true,
      note: `first ${headBudget} and last ${tailBudget} of ${text.length} characters sent`
    };
  }
  const head = lines.slice(0, headEnd).join('\n');
  const tail = tailStart < lines.length ? lines.slice(tailStart).join('\n') : '';
  const note = tail
    ? `lines 1-${headEnd} and ${tailStart + 1}-${lines.length} of ${lines.length} sent`
    : `lines 1-${headEnd} of ${lines.length} sent`;
  return { text: tail ? `${head}\n[... lines ${headEnd + 1}-${tailStart} omitted ...]\n${tail}` : head, truncated: true, note };
}

/**
 * Read one attachment as text, or null when it is binary, missing, or unsafe.
 * @param {string} uploadDir
 * @param {any} att
 * @param {RegExp} safeName
 */
export async function readAttachmentText(uploadDir, att, safeName) {
  if (!isTextAttachment(att)) return null;
  const stored = att.storedName;
  if (!stored || !safeName.test(stored)) return null;
  let handle;
  try {
    handle = await open(path.join(uploadDir, stored), 'r');
    const buf = Buffer.alloc(READ_LIMIT_BYTES);
    const { bytesRead } = await handle.read(buf, 0, READ_LIMIT_BYTES, 0);
    const data = buf.subarray(0, bytesRead);
    if (looksBinary(data)) return null;
    return data.toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Prompt text for an attachment message: the original line plus each text file.
 * @param {{content: string, attachments?: any[]}} msg
 * @param {Map<string, string>} texts storedName -> file text
 * @param {number} maxChars budget for all files in this message
 */
export function buildAttachmentPrompt(msg, texts, maxChars) {
  const files = (msg.attachments || []).filter((a) => texts.has(a.storedName));
  if (files.length === 0) return msg.content;
  const perFile = Math.max(1000, Math.floor(maxChars / files.length));
  const blocks = files.map((a) => {
    const clipped = clipText(texts.get(a.storedName) || '', perFile);
    const header = clipped.truncated ? `--- ${a.name} (${clipped.note}) ---` : `--- ${a.name} ---`;
    return `${header}\n${clipped.text}\n--- end of ${a.name} ---`;
  });
  return `${msg.content}\n\n${blocks.join('\n\n')}`;
}

/** Rough token cost of the text an attachment message will carry. */
export function attachmentTokenHint(msg, maxChars) {
  if (msg?.type !== 'attachments') return 0;
  const chars = (msg.attachments || [])
    .filter((a) => a?.text === true)
    .reduce((n, a) => n + Math.min(Number(a.size) || 0, maxChars), 0);
  return Math.ceil(Math.min(chars, maxChars) / 4);
}
