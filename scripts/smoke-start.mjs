// Starts the app the way a user does, waits for both services, then stops it.
// The install step alone does not prove the start path works.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = ['run.js', ...process.argv.slice(2)];
const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });

async function up(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
}

const deadline = Date.now() + 8 * 60 * 1000;
let ok = false;
while (Date.now() < deadline) {
  if (child.exitCode !== null) break;
  if (await up('http://127.0.0.1:4000/health') && await up('http://127.0.0.1:3000')) { ok = true; break; }
  await new Promise((r) => setTimeout(r, 3000));
}

spawnSync(process.execPath, ['run.js', 'stop'], { cwd: ROOT, stdio: 'inherit' });
child.kill();
console.log(ok ? '\nSmoke start: backend and frontend both answered.' : '\nSmoke start FAILED: services did not come up.');
process.exit(ok ? 0 : 1);
