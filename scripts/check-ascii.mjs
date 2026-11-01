// Source and docs are plain ASCII. Exceptions: the macOS Command key symbol in
// UI text, and the braille spinner frames in the launcher.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['frontend/src', 'backend/src', 'desktop', 'scripts', 'run.js', 'README.md', 'CHANGELOG.md', 'docs', '.github', 'image-service/server.py'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.venv', '__pycache__']);
const EXTS = /\.(js|jsx|mjs|cjs|ts|css|md|yml|yaml|json|py|sh|bat)$/;
const ALLOW = [
  { file: /^frontend\/src\/.*\.jsx$/, chars: new RegExp('\\u2318') },
  { file: /^run\.js$/, chars: new RegExp('[\\u2800-\\u28FF]') }
];

const problems = [];
function walk(p) {
  let st;
  try { st = statSync(p); } catch { return; }
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) if (!SKIP_DIRS.has(name)) walk(path.join(p, name));
    return;
  }
  if (!EXTS.test(p)) return;
  const rel = path.relative(ROOT, p).split(path.sep).join('/');
  const allowed = ALLOW.filter((a) => a.file.test(rel)).map((a) => a.chars);
  readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
    for (const ch of line.matchAll(/[^\x00-\x7F]/gu)) {
      if (allowed.some((re) => re.test(ch[0]))) continue;
      const code = ch[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      problems.push(`${rel}:${i + 1}: U+${code} "${ch[0]}"`);
    }
  });
}

for (const t of TARGETS) walk(path.join(ROOT, t));
if (problems.length > 0) {
  console.error(`Non-ASCII characters found (${problems.length}):`);
  for (const p of problems.slice(0, 50)) console.error(`  ${p}`);
  process.exit(1);
}
console.log('All checked files are ASCII.');
