#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');

const ROOT_DIR = __dirname;
const BACKEND_DIR = path.join(ROOT_DIR, 'backend');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');
const IMAGE_SERVICE_DIR = path.join(ROOT_DIR, 'image-service');
const PROVIDERS_DIR = path.join(ROOT_DIR, 'providers');
const MODEL_PATH = path.join(os.tmpdir(), 'mirabilis-llama-3.2-1b-instruct-q4_k_m.gguf');
const RUN_STATE_PATH = path.join(os.tmpdir(), 'mirabilis-run-state.json');
const LAUNCH_STARTED_AT = Date.now();
const phaseTimings = [];
const MIRABILIS_MANAGED_OLLAMA_MODELS = ['qwen2.5:0.5b'];

let ollamaStartedByScript = false;
const managed = {
  backend: null,
  frontend: null,
  image: null,
  llama: null,
  kobold: null,
  ollama: null
};

function supportsAnsi() {
  return Boolean(process.stdout.isTTY && process.env.NO_COLOR !== '1');
}

function color(text, code) {
  if (!supportsAnsi()) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function section(title) {
  process.stdout.write(`\n${color('==', '2')} ${color(title, '1')}\n`);
}

function statusLine(level, message) {
  const map = {
    OK: color('OK  ', '32'),
    WARN: color('WARN', '33'),
    FAIL: color('FAIL', '31'),
    INFO: color('INFO', '97')
  };
  process.stdout.write(`  [${map[level] || level}] ${message}\n`);
}

async function withPhase(name, task) {
  const started = Date.now();
  section(name);
  try {
    const result = await task();
    const ms = Date.now() - started;
    phaseTimings.push({ name, ms });
    statusLine('OK', `${name} completed in ${fmtMs(ms)}`);
    return result;
  } catch (error) {
    const ms = Date.now() - started;
    phaseTimings.push({ name, ms, failed: true });
    statusLine('FAIL', `${name} failed after ${fmtMs(ms)}`);
    throw error;
  }
}

function printStartupSummary(provider, verbose) {
  section('Summary');
  const totalMs = Date.now() - LAUNCH_STARTED_AT;
  statusLine('INFO', `Total startup time: ${fmtMs(totalMs)}`);
  statusLine('INFO', `Active provider: ${provider}`);
  statusLine('INFO', 'Frontend: http://localhost:3000');
  statusLine('INFO', 'Backend:  http://localhost:4000');
  statusLine('INFO', 'Image:    http://127.0.0.1:7860');
  statusLine('INFO', `State file: ${RUN_STATE_PATH}`);
  if (verbose) {
    statusLine('INFO', `Logs: ${path.join(os.tmpdir(), 'backend.log')}, ${path.join(os.tmpdir(), 'frontend.log')}, ${path.join(os.tmpdir(), 'image-service.log')}`);
  }
  if (phaseTimings.length > 0) {
    for (const p of phaseTimings) {
      statusLine(p.failed ? 'WARN' : 'INFO', `${p.name}: ${fmtMs(p.ms)}`);
    }
  }
}

function usage() {
  process.stdout.write(`Usage: node run.js [provider|command] [args] [--log] [--verbose] [--prod-ui]\n\nProviders:\n  ui                 - Start app and choose provider from UI (default)\n  ollama             - Use Ollama provider\n  openai-compatible  - Use llama-server as OpenAI-compatible provider\n  koboldcpp          - Use KoboldCpp provider\n\nCommands:\n  stop               - Stop processes started by launcher (PID-based); fallback to pattern kill if needed\n  restart [provider] - Stop then start again (provider optional, default: ui)\n  doctor             - Validate environment, binaries, and service reachability\n  logs               - Tail live logs from backend, frontend, and image-service\n  install            - Install dependencies (pure JavaScript, no shell needed)\n  uninstall          - Remove dependencies and caches\n\nFlags:\n  --log              - Print live backend/MCP logs to terminal and write audit files\n  --verbose          - Print richer launch diagnostics and phase summaries\n  --no-image         - Skip the image service (torch/diffusers). Everything except
                       image generation works, and a first run is far faster.
  --no-ollama        - Do not auto-install Ollama (for cloud-only setups).
  --dev-ui           - Force frontend dev mode (next dev, hot reload)\n  --prod-ui          - Force frontend production mode (next start, requires build)\n\nEnvironment:\n  MIRABILIS_THREADS  - Override CPU threads for llama-server/koboldcpp (default: all logical cores)\n\nExample:\n  node run.js\n  node run.js restart ui\n  node run.js --prod-ui\n  node run.js ollama\n  node run.js openai-compatible --log --verbose\n  node run.js doctor\n  node run.js logs\n  node run.js restart koboldcpp --log\n  node run.js install\n  node run.js uninstall\n  node run.js stop\n\n`);
}

function parseArgs(argv) {
  let logEnabled = false;
  let verbose = false;
  let devUi = true;
  let prodUi = false;
  const filtered = [];
  for (const arg of argv) {
    if (arg === '--log') {
      logEnabled = true;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--dev-ui') {
      devUi = true;
      prodUi = false;
    } else if (arg === '--prod-ui') {
      prodUi = true;
      devUi = false;
    } else {
      filtered.push(arg);
    }
  }
  const mode = filtered[0] || 'ui';
  const arg = filtered[1] || '';
  const extraArgs = filtered.slice(1);
  return { mode, arg, extraArgs, logEnabled, verbose, devUi, prodUi };
}

function hasFrontendBuild() {
  return fs.existsSync(path.join(FRONTEND_DIR, '.next', 'BUILD_ID'));
}

function normalizeProvider(raw) {
  const value = String(raw || 'ui').toLowerCase();
  if (['ui', 'ollama', 'openai-compatible', 'koboldcpp'].includes(value)) {
    return value;
  }
  return '';
}

async function readRunState() {
  try {
    const text = await fsp.readFile(RUN_STATE_PATH, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeRunState(extra = {}) {
  const pids = {};
  for (const [name, proc] of Object.entries(managed)) {
    if (proc && typeof proc.pid === 'number') {
      pids[name] = proc.pid;
    }
  }
  const payload = {
    rootDir: ROOT_DIR,
    updatedAt: new Date().toISOString(),
    pids,
    ...extra
  };
  await fsp.writeFile(RUN_STATE_PATH, JSON.stringify(payload, null, 2), 'utf8');
}

async function clearRunState() {
  try {
    await fsp.unlink(RUN_STATE_PATH);
  } catch {
    // Ignore missing state.
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminatePid(pid) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;

  if (process.platform === 'win32') {
    await runForeground('taskkill', ['/PID', String(pid), '/T', '/F'], ROOT_DIR);
    return true;
  }

  if (!isPidAlive(pid)) return false;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(200);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Ignore if already gone.
  }
  return true;
}

function detectThreadCount() {
  const env = String(process.env.MIRABILIS_THREADS || '').trim();
  if (/^\d+$/.test(env) && Number(env) > 0) return Number(env);
  return Math.max(1, os.cpus()?.length || 4);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function commandExists(cmd) {
  const checker = process.platform === 'win32' ? 'where' : 'sh';
  const args = process.platform === 'win32' ? [cmd] : ['-c', `command -v ${cmd}`];
  return new Promise((resolve) => {
    const child = spawn(checker, args, { stdio: 'ignore' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function npmCommand() {
  return process.platform === 'win32' ? 'cmd.exe' : 'npm';
}

function npmArgs(args) {
  if (process.platform === 'win32') {
    return ['/d', '/s', '/c', 'npm', ...args];
  }
  return args;
}

// Choose the install command for a package directory.
//
// This used to be an unconditional `npm install --legacy-peer-deps`, which is
// the reason the committed lockfiles kept drifting: `npm install` REWRITES
// package-lock.json, and --legacy-peer-deps skips peer resolution entirely, so
// peer-only packages get pruned from the tree it writes. A later `npm ci` in CI
// then rejects the truncated lockfile and the release fails. `npm ci` installs
// exactly what the lockfile says and never edits it, which is what a local run
// of an already-locked project wants.
function installArgs(dir) {
  if (fs.existsSync(path.join(dir, 'package-lock.json'))) {
    return ['ci', '--no-audit', '--no-fund'];
  }
  // No lockfile yet (fresh clone of an unlocked project): fall back to install,
  // which will create one.
  return ['install', '--no-audit', '--no-fund'];
}

// `validate` lets a caller require more than HTTP 200 - e.g. the image service
// returns 200 from /health even while the model failed to load, so its readiness
// check must inspect the JSON `status` field.
async function endpointReady(url, validate) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (validate) return await validate(res);
    return res.ok;
  } catch {
    return false;
  }
}

// True only when /health reports status 'ok' (not 'initializing' or 'error').
async function imageHealthReady(res) {
  if (!res.ok) return false;
  try {
    const body = await res.json();
    return body?.status === 'ok';
  } catch {
    return false;
  }
}

async function waitForEndpoint(url, timeoutMs, label, processObj, logFile, validate) {
  const started = Date.now();
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;
  const spinnerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - started) / 1000);
    const frame = spinnerFrames[spinnerIndex % spinnerFrames.length];
    process.stdout.write(`\r  ${frame} Waiting for ${label}... ${elapsed}s`);
    spinnerIndex += 1;
  }, 100);

  try {
    while (Date.now() - started < timeoutMs) {
      if (await endpointReady(url, validate)) {
        clearInterval(spinnerInterval);
        process.stdout.write('\r');
        return;
      }
      // Check if process crashed
      if (processObj && processObj.exitCode !== null) {
        clearInterval(spinnerInterval);
        process.stdout.write('\r');
        let errorMsg = `${label} exited with code ${processObj.exitCode}`;
        if (logFile && fs.existsSync(logFile)) {
          try {
            const logs = fs.readFileSync(logFile, 'utf8').split('\n').slice(-20).join('\n');
            errorMsg += `\n\nLast output:\n${logs}`;
          } catch {
            // Ignore if can't read log
          }
        }
        throw new Error(errorMsg);
      }
      await sleep(1000);
    }
    clearInterval(spinnerInterval);
    process.stdout.write('\r');
    throw new Error(`${label} did not become ready at ${url}`);
  } catch (error) {
    clearInterval(spinnerInterval);
    throw error;
  }
}

async function ensureServiceRunning({ label, url, timeoutMs, spawnService, logFile, validate }) {
  if (await endpointReady(url, validate)) {
    statusLine('INFO', `${label} already running; reusing existing service`);
    return null;
  }

  const processObj = spawnService();
  await waitForEndpoint(url, timeoutMs, label, processObj, logFile, validate);
  return processObj;
}

async function getListeningPidsOnPort(port) {
  if (!Number.isInteger(port) || port <= 0) return [];

  if (process.platform === 'win32') {
    const { code, stdout } = await runCaptured('netstat', ['-ano', '-p', 'tcp'], ROOT_DIR);
    if (code !== 0) return [];

    const pids = new Set();
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (!line.includes('LISTENING')) continue;
      // Use word-boundary match to avoid :3000 matching :30001 etc.
      // NOTE: double backslash - inside a template literal `\s` collapses to a
      // literal "s", so the boundary must be written `\\s` to reach the RegExp.
      if (!new RegExp(`:${port}(?:\\s|$)`).test(line)) continue;
      const parts = line.split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  }

  const { code, stdout } = await runCaptured('lsof', ['-nP', '-iTCP:' + String(port), '-sTCP:LISTEN', '-t'], ROOT_DIR);
  if (code !== 0) return [];
  return stdout
    .split('\n')
    .map((s) => Number(s.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function getPidCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';

  if (process.platform === 'win32') {
    const command = `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; if ($null -ne $p) { $p.CommandLine }`;
    const { code, stdout } = await runCaptured('powershell.exe', ['-NoProfile', '-Command', command], ROOT_DIR);
    if (code !== 0) return '';
    return stdout.trim();
  }

  const { code, stdout } = await runCaptured('ps', ['-p', String(pid), '-o', 'command='], ROOT_DIR);
  if (code !== 0) return '';
  return stdout.trim();
}

async function getPidWorkingDirectory(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';

  if (process.platform === 'win32') {
    return '';
  }

  const { code, stdout } = await runCaptured('lsof', ['-a', '-p', String(pid), '-d', 'cwd'], ROOT_DIR);
  if (code !== 0) return '';
  const lines = stdout.split('\n');
  const row = lines.find((line) => /\bcwd\b/.test(line));
  if (!row) return '';
  const idx = row.indexOf(' /');
  if (idx === -1) return '';
  return row.slice(idx + 1).trim();
}

async function terminateStaleMirabilisFrontendOnPort(port) {
  const pids = await getListeningPidsOnPort(port);
  if (pids.length === 0) return 0;

  const frontendDirNorm = FRONTEND_DIR.toLowerCase().replace(/\//g, '\\');
  let terminated = 0;

  for (const pid of pids) {
    const cmdLine = await getPidCommandLine(pid);
    const cwd = await getPidWorkingDirectory(pid);
    if (!cmdLine) continue;
    const cmdNorm = cmdLine.toLowerCase().replace(/\//g, '\\');
    const cwdNorm = String(cwd || '').toLowerCase().replace(/\//g, '\\');
    const isMirabilisFrontend =
      (cmdNorm.includes('next\\dist\\server\\lib\\start-server.js') || cmdNorm.includes('next dev') || cmdNorm.includes('next-server')) &&
      ((cwdNorm.includes('mirabilis') && cwdNorm.includes('frontend')) || cmdNorm.includes('mirabilis')) &&
      (cwdNorm ? cwdNorm !== frontendDirNorm : !cmdNorm.includes(frontendDirNorm));

    if (!isMirabilisFrontend) continue;
    const stopped = await terminatePid(pid);
    if (stopped) terminated += 1;
  }

  return terminated;
}

async function endpointLooksLikeMirabilisFrontend(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    const html = (await res.text()).toLowerCase();
    return html.includes('mirabilis') || html.includes('intelledger');
  } catch {
    return false;
  }
}

async function classifyFrontendPortOwner(port) {
  const pids = await getListeningPidsOnPort(port);
  if (pids.length === 0) {
    return { kind: 'none', pids: [], sample: '' };
  }

  const currentFrontendNorm = FRONTEND_DIR.toLowerCase().replace(/\//g, '\\');
  const owners = [];

  for (const pid of pids) {
    const cmdLine = await getPidCommandLine(pid);
    const cwd = await getPidWorkingDirectory(pid);
    if (!cmdLine) continue;

    const cmdNorm = cmdLine.toLowerCase().replace(/\//g, '\\');
    const cwdNorm = String(cwd || '').toLowerCase().replace(/\//g, '\\');
    const isNextFrontend =
      cmdNorm.includes('next\\dist\\server\\lib\\start-server.js') ||
      cmdNorm.includes('next dev') ||
      cmdNorm.includes('next-server');

    if (!isNextFrontend) {
      owners.push({ pid, type: 'foreign', cmdLine });
      continue;
    }

    if (cwdNorm === currentFrontendNorm || cmdNorm.includes(currentFrontendNorm)) {
      owners.push({ pid, type: 'current', cmdLine });
      continue;
    }

    if (cwdNorm && cwdNorm.includes('mirabilis') && cwdNorm.includes('frontend')) {
      owners.push({ pid, type: 'other-mirabilis', cmdLine });
      continue;
    }

    if (cmdNorm.includes('mirabilis') && cmdNorm.includes('frontend')) {
      owners.push({ pid, type: 'other-mirabilis', cmdLine });
      continue;
    }

    if (cmdNorm.includes('next-server')) {
      owners.push({ pid, type: 'ambiguous-next', cmdLine });
      continue;
    }

    owners.push({ pid, type: 'foreign', cmdLine });
  }

  if (owners.length > 0 && owners.every((o) => o.type === 'ambiguous-next')) {
    const looksLikeMirabilis = await endpointLooksLikeMirabilisFrontend(`http://127.0.0.1:${port}`);
    if (looksLikeMirabilis) {
      return { kind: 'current', pids, sample: owners[0]?.cmdLine || '' };
    }
  }

  if (owners.some((o) => o.type === 'foreign')) {
    const sample = owners.find((o) => o.type === 'foreign')?.cmdLine || '';
    return { kind: 'foreign', pids, sample };
  }

  if (owners.some((o) => o.type === 'other-mirabilis')) {
    return { kind: 'other-mirabilis', pids, sample: owners[0]?.cmdLine || '' };
  }

  if (owners.some((o) => o.type === 'current')) {
    return { kind: 'current', pids, sample: owners[0]?.cmdLine || '' };
  }

  return { kind: 'foreign', pids, sample: owners[0]?.cmdLine || '' };
}

function ensureDeps() {
  const missingNode = !fs.existsSync(path.join(BACKEND_DIR, 'node_modules')) || !fs.existsSync(path.join(FRONTEND_DIR, 'node_modules'));
  if (missingNode) {
    throw new Error('Dependencies not installed. Run: node run.js install');
  }

  const venvUnix = path.join(IMAGE_SERVICE_DIR, '.venv', 'bin', 'python');
  const venvWin = path.join(IMAGE_SERVICE_DIR, '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(venvUnix) && !fs.existsSync(venvWin)) {
    throw new Error('Python environment not set up. Run: node run.js install');
  }
}

function imagePythonPath() {
  const venvWin = path.join(IMAGE_SERVICE_DIR, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvWin)) return venvWin;
  return path.join(IMAGE_SERVICE_DIR, '.venv', 'bin', 'python');
}

function missingImagePythonPackages() {
  const py = imagePythonPath();
  const moduleChecks = [
    { module: 'flask', pkg: 'flask' },
    { module: 'torch', pkg: 'torch' },
    { module: 'torchvision', pkg: 'torchvision' },
    { module: 'diffusers', pkg: 'diffusers' },
    { module: 'transformers', pkg: 'transformers' },
    { module: 'accelerate', pkg: 'accelerate' },
    { module: 'PIL', pkg: 'Pillow' }
  ];

  const missing = [];
  for (const { module, pkg } of moduleChecks) {
    const check = spawnSync(py, ['-c', `import ${module}`], {
      cwd: IMAGE_SERVICE_DIR,
      stdio: 'ignore'
    });
    if (check.status !== 0) missing.push(pkg);
  }
  return [...new Set(missing)];
}

async function ensureImageServicePythonDeps() {
  const missing = missingImagePythonPackages();
  if (missing.length === 0) return;

  statusLine('INFO', `Installing missing image-service Python packages: ${missing.join(', ')}`);
  const py = imagePythonPath();
  const code = await runForeground(py, ['-m', 'pip', 'install', ...missing], IMAGE_SERVICE_DIR);
  if (code !== 0) {
    throw new Error('Failed installing image-service Python packages');
  }
}

function resolveOllamaBin() {
  if (process.platform === 'win32') {
    const candidate = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'ollama';
}

async function hasOllamaCommand() {
  const ollamaBin = resolveOllamaBin();
  if (ollamaBin !== 'ollama') return true;
  return commandExists('ollama');
}

async function ensureOllamaReady() {
  if (await endpointReady('http://127.0.0.1:11434/api/tags')) return true;
  const ollamaBin = resolveOllamaBin();
  if (!(await hasOllamaCommand())) return false;

  process.stdout.write('Starting Ollama service...\n');
  const out = fs.openSync(path.join(os.tmpdir(), 'ollama.log'), 'a');
  managed.ollama = spawn(ollamaBin, ['serve'], { stdio: ['ignore', out, out] });
  ollamaStartedByScript = true;

  for (let i = 0; i < 20; i += 1) {
    if (await endpointReady('http://127.0.0.1:11434/api/tags')) return true;
    await sleep(1000);
  }
  return false;
}

async function ensureOllamaModel() {
  const ollamaBin = resolveOllamaBin();
  if (!(await hasOllamaCommand())) return false;
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(4000) });
    const body = await res.json();
    const count = Array.isArray(body?.models) ? body.models.length : 0;
    if (count >= 1) {
      statusLine('OK', `Ollama: ${count} model(s) available`);
      return true;
    }
  } catch {
    // Continue to pull attempt.
  }

  statusLine('INFO', 'No Ollama models found - pulling qwen2.5:0.5b (one-time, ~400MB)...');
  const code = await runForeground(ollamaBin, ['pull', 'qwen2.5:0.5b'], ROOT_DIR);
  if (code === 0) statusLine('OK', 'Ollama default model ready');
  return code === 0;
}


// ── Provider binary installation, cross platform ────────────────────────────
//
// Pinned by default so an install is reproducible and nobody silently runs
// whatever upstream published this morning. Override to move to a newer build.
/** A local engine is not needed by someone using only cloud providers. */
function skipOllama() {
  return process.env.MIRABILIS_SKIP_OLLAMA === '1'
    || process.argv.includes('--no-ollama');
}

/**
 * Image generation is optional and by far the heaviest part of an install:
 * torch and diffusers are a multi-gigabyte download, and the model assets are
 * another one on first use.
 *
 * One predicate governs BOTH installing and starting it. MIRABILIS_SKIP_IMAGE
 * already existed for the start path; skipping the start while still spending
 * ten minutes installing torch would be a strange thing to ask for, so the same
 * answer is used for both. --no-image is the same switch for people who would
 * rather not remember an environment variable.
 */
function skipImageService() {
  return process.env.MIRABILIS_SKIP_IMAGE_SERVICE === '1'
    || process.env.MIRABILIS_SKIP_IMAGE === '1'
    || process.argv.includes('--no-image');
}

const LLAMACPP_TAG = process.env.MIRABILIS_LLAMACPP_TAG || 'b10819';
const KOBOLDCPP_TAG = process.env.MIRABILIS_KOBOLDCPP_TAG || 'v1.117.1';

/** Download a URL to a file. Fails loudly: a truncated binary is worse than none. */
async function downloadTo(url, destPath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`Download was empty: ${url}`);
  await fsp.writeFile(destPath, buf);
  return buf.length;
}

/**
 * Extract a .zip or .tar.gz without assuming any one tool exists.
 *
 * bsdtar (macOS, and Windows 10+) reads both formats, so `tar -xf` covers those.
 * GNU tar on Linux cannot read a zip, so unzip is tried there. Each candidate is
 * attempted in turn rather than assuming, because the previous code shelled out
 * to `unzip` and `rm -rf`, neither of which exists on a stock Windows.
 */
async function extractArchive(archivePath, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const isZip = archivePath.toLowerCase().endsWith('.zip');
  const candidates = [];
  if (isZip) {
    if (process.platform === 'linux') candidates.push(['unzip', ['-qo', archivePath, '-d', destDir]]);
    candidates.push(['tar', ['-xf', archivePath, '-C', destDir]]);
    if (process.platform === 'win32') {
      candidates.push(['powershell.exe', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`]]);
    }
  } else {
    candidates.push(['tar', ['-xzf', archivePath, '-C', destDir]]);
  }
  const tried = [];
  for (const [cmd, args] of candidates) {
    const result = spawnSync(cmd, args, { stdio: 'ignore' });
    if (!result.error && result.status === 0) return;
    tried.push(cmd);
  }
  throw new Error(
    `Could not extract ${path.basename(archivePath)} (tried: ${tried.join(', ')}).\n` +
    `  Extract it by hand into ${PROVIDERS_DIR} and re-run.`
  );
}

/** Find a file by name anywhere under dir. Release layouts move binaries around. */
function findFileRecursive(dir, fileName) {
  let stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === fileName) return full;
    }
  }
  return null;
}

/**
 * The direct download URL for a release asset.
 *
 * Preferred over the releases API because the API is rate limited per IP for
 * unauthenticated callers, and shared IPs hit that limit routinely: on a CI
 * macOS runner every asset lookup came back 403 and the install quietly
 * produced nothing. Release downloads do not share that limit. Since the tags
 * are pinned, the asset name is known exactly, so the API is only needed when
 * that guess is wrong.
 */
function releaseAssetUrl(repo, tag, assetName) {
  return `https://github.com/${repo}/releases/download/${tag}/${assetName}`;
}

/** Fetch a GitHub release by tag. Fallback path: see releaseAssetUrl. */
async function githubRelease(repo, tag) {
  const headers = { 'User-Agent': 'mirabilis-launcher' };
  // A token is optional and only raises the rate limit; never required.
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers });
  if (!res.ok) {
    throw new Error(
      `Could not read ${repo} release ${tag} (HTTP ${res.status}).` +
      (res.status === 403 ? ' GitHub rate limit: set GITHUB_TOKEN, or retry later.' : '')
    );
  }
  return res.json();
}

/**
 * The plain CPU llama.cpp asset for this machine.
 * Accelerator builds (cuda, vulkan, sycl, rocm, openvino, opencl) are excluded:
 * they need drivers most machines do not have, and fail at startup rather than
 * at install, which is the worst place to find out.
 */
function llamaAssetName(tag, platform, arch) {
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'darwin') return `llama-${tag}-bin-macos-${a}.tar.gz`;
  if (platform === 'linux') return `llama-${tag}-bin-ubuntu-${a}.tar.gz`;
  if (platform === 'win32') return `llama-${tag}-bin-win-cpu-${a}.zip`;
  return null;
}

/** Is this URL downloadable? Used to check a guessed asset name cheaply. */
async function urlExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return res.ok;
  } catch {
    return false;
  }
}

function llamaAssetPattern(platform, arch) {
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'darwin') return new RegExp(`^llama-.*-bin-macos-${a}\\.(tar\\.gz|zip)$`);
  if (platform === 'linux') return new RegExp(`^llama-.*-bin-ubuntu-${a}\\.(tar\\.gz|zip)$`);
  if (platform === 'win32') return new RegExp(`^llama-.*-bin-win-cpu-${a}\\.zip$`);
  return null;
}

/** The koboldcpp asset for this machine, preferring the standard build. */
function koboldAssetName(platform, arch) {
  if (platform === 'darwin') return arch === 'arm64' ? 'koboldcpp-mac-arm64' : null;
  if (platform === 'linux') return arch === 'x64' ? 'koboldcpp-linux-x64' : null;
  if (platform === 'win32') return arch === 'x64' ? 'koboldcpp.exe' : null;
  return null;
}

function manualProviderHint(what) {
  return `${what} has no prebuilt download for ${process.platform}/${process.arch}.\n` +
    `  Mirabilis works without it - Ollama is the default provider.\n` +
    `  To use it, build or download it yourself and place it in ${PROVIDERS_DIR}.`;
}

async function installLlamaServer() {
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const target = path.join(PROVIDERS_DIR, exeName);
  if (fs.existsSync(target)) { statusLine('OK', 'llama-server already exists'); return; }

  const pattern = llamaAssetPattern(process.platform, process.arch);
  if (!pattern) { statusLine('WARN', manualProviderHint('llama-server')); return; }

  statusLine('INFO', `Installing llama-server (${LLAMACPP_TAG}, ${process.platform}/${process.arch})...`);

  // The pinned tag makes the asset name predictable, so try the direct download
  // before spending a rate-limited API call.
  const guessName = llamaAssetName(LLAMACPP_TAG, process.platform, process.arch);
  let assetName = guessName;
  let assetUrl = guessName ? releaseAssetUrl('ggml-org/llama.cpp', LLAMACPP_TAG, guessName) : null;
  if (!assetUrl || !(await urlExists(assetUrl))) {
    const release = await githubRelease('ggml-org/llama.cpp', LLAMACPP_TAG);
    const asset = (release.assets || []).find((a) => pattern.test(a.name));
    if (!asset) { statusLine('WARN', manualProviderHint('llama-server')); return; }
    assetName = asset.name;
    assetUrl = asset.browser_download_url;
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mirabilis-llama-'));
  try {
    const archive = path.join(tmpDir, assetName);
    await downloadTo(assetUrl, archive);
    await extractArchive(archive, tmpDir);
    const found = findFileRecursive(tmpDir, exeName);
    if (!found) throw new Error(`${exeName} was not in ${assetName}`);
    await fsp.copyFile(found, target);
    if (process.platform !== 'win32') await fsp.chmod(target, 0o755);

    // llama-server needs its shared libraries beside it on macOS and Linux.
    // Copying only the executable produced a binary that installed cleanly and
    // then failed to start with a dynamic-linker error.
    const libDir = path.dirname(found);
    for (const entry of await fsp.readdir(libDir)) {
      if (/\.(so|so\.\d+|dylib|dll)$/.test(entry) || /^lib.*\.(so|dylib)/.test(entry)) {
        await fsp.copyFile(path.join(libDir, entry), path.join(PROVIDERS_DIR, entry)).catch(() => {});
      }
    }
    // The CLI is handy but optional; never fail the install for it.
    const cli = findFileRecursive(tmpDir, process.platform === 'win32' ? 'llama-cli.exe' : 'llama-cli');
    if (cli) {
      const cliTarget = path.join(PROVIDERS_DIR, path.basename(cli));
      await fsp.copyFile(cli, cliTarget).catch(() => {});
      if (process.platform !== 'win32') await fsp.chmod(cliTarget, 0o755).catch(() => {});
    }
    statusLine('OK', 'llama-server installed');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function installKoboldCpp() {
  const exeName = process.platform === 'win32' ? 'koboldcpp.exe' : 'koboldcpp';
  const target = path.join(PROVIDERS_DIR, exeName);
  if (fs.existsSync(target)) { statusLine('OK', 'koboldcpp already exists'); return; }

  const assetName = koboldAssetName(process.platform, process.arch);
  if (!assetName) { statusLine('WARN', manualProviderHint('KoboldCpp')); return; }

  statusLine('INFO', `Installing KoboldCpp (${KOBOLDCPP_TAG}, ${process.platform}/${process.arch})...`);
  let url = releaseAssetUrl('LostRuins/koboldcpp', KOBOLDCPP_TAG, assetName);
  if (!(await urlExists(url))) {
    const release = await githubRelease('LostRuins/koboldcpp', KOBOLDCPP_TAG);
    const asset = (release.assets || []).find((a) => a.name === assetName);
    if (!asset) { statusLine('WARN', manualProviderHint('KoboldCpp')); return; }
    url = asset.browser_download_url;
  }

  await downloadTo(url, target);
  if (process.platform !== 'win32') await fsp.chmod(target, 0o755);
  statusLine('OK', 'koboldcpp installed');
}

/**
 * Install the optional local provider runtimes.
 *
 * Never fatal. Ollama is the default provider and needs none of this, so a
 * machine with no prebuilt binary still gets a working app; it just cannot use
 * the llama.cpp or KoboldCpp providers.
 */
async function installProviderBinaries() {
  if (!fs.existsSync(PROVIDERS_DIR)) fs.mkdirSync(PROVIDERS_DIR, { recursive: true });
  statusLine('INFO', `Installing provider runtimes (${process.platform}/${process.arch})...`);
  for (const [name, install] of [['llama-server', installLlamaServer], ['KoboldCpp', installKoboldCpp]]) {
    try {
      await install();
    } catch (error) {
      statusLine('WARN', `${name} install skipped: ${error.message || error}`);
      statusLine('INFO', 'Mirabilis still runs: Ollama is the default provider.');
    }
  }
}

async function ensureLlamaModel(modelPath) {
  let needsDownload = false;
  try {
    await fsp.access(modelPath, fs.constants.F_OK);
    const fd = await fsp.open(modelPath, 'r');
    const buffer = Buffer.alloc(4);
    await fd.read(buffer, 0, 4, 0);
    await fd.close();
    if (buffer.toString('utf8') !== 'GGUF') needsDownload = true;
  } catch {
    needsDownload = true;
  }

  if (needsDownload) {
    process.stdout.write('Downloading llama model (one-time)...\n');
    const url = 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf';
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error('Failed to download llama model.');
    }
    const tempPath = `${modelPath}.tmp`;
    const out = fs.createWriteStream(tempPath);
    await new Promise((resolve, reject) => {
      Readable.fromWeb(res.body).pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    });
    await fsp.rename(tempPath, modelPath);
  }

  const fd = await fsp.open(modelPath, 'r');
  const buffer = Buffer.alloc(4);
  await fd.read(buffer, 0, 4, 0);
  await fd.close();
  if (buffer.toString('utf8') !== 'GGUF') {
    throw new Error('Downloaded model is invalid (not GGUF).');
  }
}

async function startOpenAICompatible(threads) {
  const llamaBin = path.join(PROVIDERS_DIR, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  if (!fs.existsSync(llamaBin)) {
    // Say what will actually help. Telling every platform to run `install` was
    // a dead end wherever no prebuilt binary exists: the command runs, reports
    // success, and the binary is still missing.
    process.stderr.write(
      llamaAssetPattern(process.platform, process.arch)
        ? 'llama-server not found. Run: node run.js install\n'
        : `${manualProviderHint('llama-server')}\n`
    );
    return false;
  }

  try {
    await ensureLlamaModel(MODEL_PATH);
  } catch (error) {
    process.stderr.write(`${error.message || 'Failed to prepare llama model.'}\n`);
    return false;
  }
  process.stdout.write(`Starting llama-server (OpenAI-compatible, threads=${threads})...\n`);

  const out = fs.openSync(path.join(os.tmpdir(), 'llama.log'), 'a');
  managed.llama = spawn(llamaBin, [
    '-m', MODEL_PATH,
    '-ngl', '50',
    '--threads', String(threads),
    '--threads-batch', String(threads),
    '--threads-http', String(threads),
    '--port', '8000'
  ], { stdio: ['ignore', out, out] });

  for (let i = 0; i < 30; i += 1) {
    if (await endpointReady('http://127.0.0.1:8000/v1/models')) return true;
    await sleep(1000);
  }

  process.stderr.write('OpenAI-compatible provider did not become ready at http://127.0.0.1:8000/v1/models\n');
  return false;
}

async function startKoboldCpp(threads) {
  const koboldBin = path.join(PROVIDERS_DIR, process.platform === 'win32' ? 'koboldcpp.exe' : 'koboldcpp');
  if (!fs.existsSync(koboldBin)) {
    process.stderr.write(
      koboldAssetName(process.platform, process.arch)
        ? 'koboldcpp not found. Run: node run.js install\n'
        : `${manualProviderHint('KoboldCpp')}\n`
    );
    return false;
  }

  try {
    await ensureLlamaModel(MODEL_PATH);
  } catch (error) {
    process.stderr.write(`${error.message || 'Failed to prepare llama model.'}\n`);
    return false;
  }
  process.stdout.write(`Starting KoboldCpp (threads=${threads})...\n`);

  const out = fs.openSync(path.join(os.tmpdir(), 'koboldcpp.log'), 'a');
  managed.kobold = spawn(koboldBin, [
    '--model', MODEL_PATH,
    '--host', '127.0.0.1',
    '--port', '5001',
    '--threads', String(threads),
    '--blasthreads', String(threads),
    '--quiet'
  ], { stdio: ['ignore', out, out] });

  for (let i = 0; i < 30; i += 1) {
    if (await endpointReady('http://127.0.0.1:5001/v1/models')) return true;
    await sleep(1000);
  }

  process.stderr.write('KoboldCpp did not become ready at http://127.0.0.1:5001/v1/models\n');
  return false;
}

function spawnLogged(command, args, cwd, env, logFile, live) {
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  if (live) {
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  }
  return child;
}

function runForeground(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('close', (code) => resolve(code || 0));
    child.on('error', () => resolve(1));
  });
}

function runCaptured(command, args, cwd) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolve({ code: code || 0, stdout, stderr }));
    child.on('error', () => resolve({ code: 1, stdout, stderr }));
  });
}

async function getInstalledOllamaModels() {
  const ollamaBin = resolveOllamaBin();
  const { code, stdout } = await runCaptured(ollamaBin, ['list'], ROOT_DIR);
  if (code !== 0) return new Set();

  const models = new Set();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('NAME')) continue;
    const [name] = trimmed.split(/\s{2,}/);
    if (name) models.add(name);
  }
  return models;
}

async function installOllama() {
  statusLine('INFO', 'Ollama not found - attempting auto-install...');
  if (process.platform === 'darwin') {
    if (await commandExists('brew')) {
      statusLine('INFO', 'Installing Ollama via Homebrew (this may take a minute)...');
      const code = await runForeground('brew', ['install', 'ollama'], ROOT_DIR);
      if (code !== 0) throw new Error('Ollama auto-install via Homebrew failed.\nInstall manually: brew install ollama');
      statusLine('OK', 'Ollama installed via Homebrew');
    } else {
      throw new Error('Ollama not installed and Homebrew not found.\n  Install Homebrew: https://brew.sh\n  Then install Ollama: brew install ollama');
    }
  } else if (process.platform === 'linux') {
    statusLine('INFO', 'Installing Ollama via official install script...');
    const code = await runForeground('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], ROOT_DIR);
    if (code !== 0) throw new Error('Ollama auto-install failed.\nInstall manually: https://ollama.com/download');
    statusLine('OK', 'Ollama installed');
  } else if (process.platform === 'win32') {
    statusLine('INFO', 'Installing Ollama via official PowerShell installer (this may take a minute)...');
    statusLine('INFO', 'Note: Administrator privileges may be required.');
    const code = await runForeground('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      'irm https://ollama.com/install.ps1 | iex'
    ], ROOT_DIR);
    if (code !== 0) {
      throw new Error(
        'Ollama auto-install via PowerShell failed.\n' +
        '  Possible causes: no admin rights, network error, or ExecutionPolicy restrictions.\n' +
        '  Install manually: https://ollama.com/download\n' +
        '  Then rerun: node run.js'
      );
    }
    statusLine('OK', 'Ollama installed via PowerShell installer');
    // The installer adds Ollama to PATH but only for new processes.
    // Inject the known install directory into the current process PATH so
    // subsequent commandExists() and spawn() calls find ollama.exe immediately.
    const ollamaInstallDir = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama');
    if (fs.existsSync(ollamaInstallDir)) {
      process.env.PATH = `${ollamaInstallDir}${path.delimiter}${process.env.PATH}`;
      statusLine('INFO', `Added Ollama to PATH: ${ollamaInstallDir}`);
    }
  } else {
    throw new Error('Ollama not installed.\nDownload and install from: https://ollama.com/download\nThen rerun: node run.js');
  }
}

async function runInstall() {
  statusLine('INFO', 'Installing Mirabilis dependencies...');

  // Check Node.js
  if (!(await commandExists('node'))) {
    throw new Error('Node.js not found. Install from https://nodejs.org');
  }
  statusLine('OK', `Node.js: ${require('child_process').execSync('node -v', { encoding: 'utf8' }).trim()}`);

  // Check Ollama - auto-install if missing.
  //
  // Skippable, because it is not always wanted: someone using only cloud
  // providers does not need a local engine, and CI must be able to prove this
  // launcher works on each platform without pulling a multi-gigabyte runtime.
  if (skipOllama()) {
    statusLine('INFO', 'Ollama install skipped (--no-ollama / MIRABILIS_SKIP_OLLAMA).');
  } else if (!(await hasOllamaCommand())) {
    await installOllama();
    statusLine('OK', 'Ollama: installed');
  } else {
    statusLine('OK', 'Ollama: installed');
  }

  // Ensure Ollama service is running so we can check/pull models.
  // All of this is Ollama work; skip it wholesale when Ollama is opted out,
  // otherwise the launcher would try to start a binary that is not there.
  if (!skipOllama()) {
  const ollamaRunning = await endpointReady('http://127.0.0.1:11434');
  if (!ollamaRunning) {
    statusLine('INFO', 'Starting Ollama service...');
    const ollamaLog = path.join(os.tmpdir(), 'ollama-install.log');
    const ollamaOut = fs.openSync(ollamaLog, 'a');
    const ollamaBin = resolveOllamaBin();
    const ollamaProc = spawn(ollamaBin, ['serve'], { stdio: ['ignore', ollamaOut, ollamaOut], detached: true });
    ollamaProc.unref();
    // Wait up to 10s for it to become ready
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      if (await endpointReady('http://127.0.0.1:11434')) break;
    }
  }

  // Ensure at least one Ollama model is available - pull default if none
  await ensureOllamaModel();
  } // end Ollama setup

  // Install backend
  statusLine('INFO', 'Installing backend dependencies...');
  const backendCode = await runForeground(npmCommand(), npmArgs(installArgs(BACKEND_DIR)), BACKEND_DIR);
  if (backendCode !== 0) {
    throw new Error('Backend npm install failed');
  }

  // Install frontend
  statusLine('INFO', 'Installing frontend dependencies...');
  const frontendCode = await runForeground(npmCommand(), npmArgs(installArgs(FRONTEND_DIR)), FRONTEND_DIR);
  if (frontendCode !== 0) {
    throw new Error('Frontend npm install failed');
  }

  // Setup Python venv, unless the caller opted out.
  //
  // This step pulls torch and diffusers, which is a multi-gigabyte download and
  // by far the slowest part of a first run. It only powers image generation, so
  // anyone who does not want that (and CI, which must not spend ten minutes
  // downloading torch to prove the launcher works) can skip it.
  if (skipImageService()) {
    statusLine('INFO', 'Skipping the image service (MIRABILIS_SKIP_IMAGE_SERVICE / --no-image).');
    statusLine('INFO', 'Everything except image generation works. Re-run without the flag to add it.');
  } else {
  statusLine('INFO', 'Setting up Python environment (this may take several minutes on first run)...');
  const venvPath = path.join(IMAGE_SERVICE_DIR, '.venv');
  if (!fs.existsSync(venvPath)) {
    const venvCode = await runForeground('python3', ['-m', 'venv', venvPath], IMAGE_SERVICE_DIR);
    if (venvCode !== 0) {
      throw new Error('Python venv creation failed');
    }
  }

  const pythonExe = imagePythonPath();
  const pipCode = await runForeground(pythonExe, ['-m', 'pip', 'install', '--upgrade', 'pip'], IMAGE_SERVICE_DIR);
  if (pipCode !== 0) {
    throw new Error('pip upgrade failed');
  }

  statusLine('INFO', 'Installing Python packages (torch/diffusers are large - this will take several minutes)...');
  const reqsCode = await runForeground(pythonExe, ['-m', 'pip', 'install', '--progress-bar', 'on', '-r', 'requirements.txt'], IMAGE_SERVICE_DIR);
  if (reqsCode !== 0) {
    throw new Error('Python requirements install failed');
  }

  } // end image service setup

  // Provider binaries, on every platform.
  //
  // These used to install on macOS only. Everywhere else the step was skipped
  // with a warning, and then the runtime told the user "llama-server not found.
  // Run: node run.js install" - a command that, on their platform, would never
  // install it. An instruction the user cannot act on is worse than an honest
  // "not supported here".
  //
  // The upstream layouts differ, and both matter:
  //   llama.cpp  ships .tar.gz for macOS and Linux, .zip for Windows, and
  //              publishes many accelerator variants (cuda, vulkan, sycl, rocm,
  //              openvino) alongside the plain CPU build. Picking the wrong one
  //              gives a binary that will not start on most machines.
  //   koboldcpp  ships a single bare executable per platform.
  await installProviderBinaries();

  // Validation
  statusLine('INFO', 'Validating installation...');
  
  // Ensure backend provider adapters exist
  const backendProvidersDir = path.join(BACKEND_DIR, 'src', 'providers');
  if (!fs.existsSync(backendProvidersDir)) {
    fs.mkdirSync(backendProvidersDir, { recursive: true });
  }

  const ollamaProviderFile = path.join(backendProvidersDir, 'ollama.js');
  const openaiProviderFile = path.join(backendProvidersDir, 'openaiCompatible.js');

  // Create ollama provider if missing
  if (!fs.existsSync(ollamaProviderFile)) {
    const ollamaCode = `// Ollama provider adapter for local LLM chat

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

export async function listOllamaModels(baseUrl) {
  const base = baseUrl || OLLAMA_BASE_URL;
  try {
    const res = await fetch(\`\${base}/api/tags\`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(m => ({
      id: m.name,
      name: m.name,
      size: m.size ? \`\${(m.size / 1e9).toFixed(1)} GB\` : 'unknown'
    }));
  } catch (error) {
    console.error('Failed to list Ollama models:', error.message);
    return [];
  }
}

export async function streamOllamaChat({ baseUrl, model, messages, signal, onToken, temperature, maxTokens }) {
  const base = baseUrl || OLLAMA_BASE_URL;
  const payload = {
    model,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content
    })),
    stream: true,
    ...(temperature != null ? { options: { temperature } } : {}),
    ...(maxTokens != null ? { options: { ...(temperature != null ? { temperature } : {}), num_predict: maxTokens } } : {}),
  };

  try {
    const res = await fetch(\`\${base}/api/chat\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      throw new Error(\`Ollama API error: \${res.status}\`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.message?.content) {
            onToken(json.message.content);
          }
        } catch {
          // Ignore JSON parse errors for partial lines
        }
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') onToken(\`\\n[Ollama error: \${error.message}]\`);
  }
}
`;
    await fsp.writeFile(ollamaProviderFile, ollamaCode, 'utf8');
    statusLine('OK', 'Created backend provider: ollama.js');
  }

  // Create OpenAI-compatible provider if missing
  if (!fs.existsSync(openaiProviderFile)) {
    const openaiCode = `// OpenAI-compatible provider adapter (llama-server, compatible APIs)

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:8000/v1';

export async function listOpenAICompatibleModels(baseUrl) {
  const base = baseUrl || OPENAI_BASE_URL;
  try {
    const res = await fetch(\`\${base}/models\`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map(m => ({
      id: m.id,
      name: m.id,
      owned_by: m.owned_by || 'unknown'
    }));
  } catch (error) {
    console.error('Failed to list OpenAI-compatible models:', error.message);
    return [];
  }
}

export async function streamOpenAICompatibleChat({ baseUrl, apiKey, model, messages, signal, onToken, temperature, maxTokens }) {
  const base = baseUrl || OPENAI_BASE_URL;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = \`Bearer \${apiKey}\`;

  const payload = {
    model,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content
    })),
    stream: true,
    ...(temperature != null ? { temperature } : {}),
    ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
  };

  try {
    const res = await fetch(\`\${base}/chat/completions\`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      throw new Error(\`OpenAI-compatible API error: \${res.status}\`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || line.trim() === '[DONE]') continue;
        if (!line.startsWith('data: ')) continue;

        try {
          const json = JSON.parse(line.slice(6));
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            onToken(delta);
          }
        } catch {
          // Ignore JSON parse errors for partial lines
        }
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') onToken(\`\\n[OpenAI-compatible error: \${error.message}]\`);
  }
}
`;
    await fsp.writeFile(openaiProviderFile, openaiCode, 'utf8');
    statusLine('OK', 'Created backend provider: openaiCompatible.js');
  }
  
  let validationFailed = false;

  if (!fs.existsSync(path.join(BACKEND_DIR, 'node_modules'))) {
    statusLine('FAIL', 'Backend node_modules missing');
    validationFailed = true;
  }

  if (!fs.existsSync(path.join(FRONTEND_DIR, 'node_modules'))) {
    statusLine('FAIL', 'Frontend node_modules missing');
    validationFailed = true;
  }

  // Only demand the Python environment if we were asked to install it.
  // Validating a component the caller explicitly skipped turned --no-image into
  // a guaranteed failure at the very last step, after everything else had
  // installed correctly.
  if (!skipImageService() && !fs.existsSync(imagePythonPath())) {
    statusLine('FAIL', 'Python venv not set up');
    validationFailed = true;
  }

  if (!fs.existsSync(ollamaProviderFile)) {
    statusLine('FAIL', 'Backend provider: ollama.js missing');
    validationFailed = true;
  }

  if (!fs.existsSync(openaiProviderFile)) {
    statusLine('FAIL', 'Backend provider: openaiCompatible.js missing');
    validationFailed = true;
  }

  if (validationFailed) {
    throw new Error('Installation failed validation');
  }

  statusLine('OK', 'Installation complete!');
  statusLine('INFO', 'Next: node run.js [ui|ollama|openai-compatible|koboldcpp]');
}

async function runUninstall() {
  // Prompt for confirmation
  process.stdout.write('\n');
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('Remove Mirabilis files and caches? (yes/no): ', async (answer) => {
      rl.close();

      if (answer !== 'yes') {
        process.stdout.write('Cancelled.\n');
        resolve();
        return;
      }

      try {
        // Remove Ollama models
        if (await hasOllamaCommand()) {
          statusLine('INFO', 'Removing Ollama models...');
          const ollamaBin = resolveOllamaBin();
          const installedModels = await getInstalledOllamaModels();
          const removableModels = MIRABILIS_MANAGED_OLLAMA_MODELS.filter((model) => installedModels.has(model));
          if (removableModels.length === 0) {
            statusLine('INFO', 'No Mirabilis-managed Ollama models found.');
          }
          for (const model of removableModels) {
            const rmCode = await runForeground(ollamaBin, ['rm', model], ROOT_DIR);
            if (rmCode === 0) {
              statusLine('OK', `Removed Ollama model: ${model}`);
            }
          }
        }

        // Remove dependencies
        statusLine('INFO', 'Removing dependencies...');
        [
          path.join(BACKEND_DIR, 'node_modules'),
          path.join(FRONTEND_DIR, 'node_modules'),
          path.join(IMAGE_SERVICE_DIR, '.venv'),
          path.join(BACKEND_DIR, 'data', 'chats.json'),
          path.join(BACKEND_DIR, '.env'),
          path.join(FRONTEND_DIR, '.env.local'),
          MODEL_PATH,
          RUN_STATE_PATH
        ].forEach(dir => {
          if (fs.existsSync(dir)) {
            if (fs.lstatSync(dir).isDirectory()) {
              fs.rmSync(dir, { recursive: true, force: true });
              statusLine('OK', `Removed ${dir}`);
            } else {
              fs.unlinkSync(dir);
              statusLine('OK', `Removed ${dir}`);
            }
          }
        });

        statusLine('INFO', 'Uninstall complete.');
      } catch (error) {
        statusLine('FAIL', error.message);
        process.exit(1);
      }
    });
  });
}

async function stopAll() {
  process.stdout.write('Stopping Mirabilis and provider processes...\n');
  let stoppedAny = false;

  const state = await readRunState();
  const pidValues = Object.values(state?.pids || {}).filter((pid) => Number.isInteger(pid));
  for (const pid of pidValues) {
    const stopped = await terminatePid(pid);
    stoppedAny = stoppedAny || stopped;
  }

  if (!stoppedAny) {
    // No recorded PID state. We deliberately do NOT fall back to broad
    // `taskkill /IM node.exe` / `pkill -f` here: those match unrelated processes
    // (the user's editor, another project's `next dev`, an unrelated Ollama) and
    // would kill them with unsaved work. Instead, target only the processes that
    // are actually listening on Mirabilis's own ports.
    process.stdout.write('No active PID state found; stopping only processes on Mirabilis ports (3000, 4000, 7860).\n');
    for (const port of [3000, 4000, 7860]) {
      const pids = await getListeningPidsOnPort(port);
      for (const pid of pids) {
        if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
          const stopped = await terminatePid(pid);
          stoppedAny = stoppedAny || stopped;
        }
      }
    }
    if (!stoppedAny) {
      process.stdout.write('Nothing to stop. If a service is still running, close its terminal or reboot; Mirabilis will not force-kill unrelated processes by name.\n');
    }
  }

  await clearRunState();
  process.stdout.write('Stopped\n');
}

async function runDoctor() {
  // Two kinds of check, and conflating them made `doctor` useless as a gate.
  //
  //   required     something is missing that a working install needs
  //   informational  a service is simply not running right now
  //
  // Everything used to be treated as a failure, so `doctor` on a correctly
  // installed machine that had not been started yet exited 1 and reported
  // "4 warning(s)". Any script wrapping it, CI included, read that as broken.
  const checks = [];
  const add = (name, ok, detail, required = true) => checks.push({ name, ok, detail, required });
  const info = (name, ok, detail) => add(name, ok, detail, false);

  add('backend node_modules', fs.existsSync(path.join(BACKEND_DIR, 'node_modules')), path.join(BACKEND_DIR, 'node_modules'));
  add('frontend node_modules', fs.existsSync(path.join(FRONTEND_DIR, 'node_modules')), path.join(FRONTEND_DIR, 'node_modules'));

  const pyPath = imagePythonPath();
  // Optional: only image generation needs it (see --no-image).
  info('image-service python venv', fs.existsSync(pyPath), pyPath);

  const llamaBin = path.join(PROVIDERS_DIR, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  const koboldBin = path.join(PROVIDERS_DIR, process.platform === 'win32' ? 'koboldcpp.exe' : 'koboldcpp');
  // Optional: alternative local engines. Ollama alone is a working setup.
  info('llama-server binary', fs.existsSync(llamaBin), llamaBin);
  info('koboldcpp binary', fs.existsSync(koboldBin), koboldBin);

  const hasOllama = await hasOllamaCommand();
  const ollamaBin = resolveOllamaBin();
  // Optional: a cloud-only setup needs no local engine (see --no-ollama).
  info('ollama command', hasOllama, hasOllama ? `available (${ollamaBin})` : 'not found');
  info('ollama endpoint', await endpointReady('http://127.0.0.1:11434/api/tags'), 'http://127.0.0.1:11434/api/tags');

  info('backend endpoint', await endpointReady('http://127.0.0.1:4000/health'), 'http://127.0.0.1:4000/health');
  info('frontend endpoint', await endpointReady('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  info('image endpoint', await endpointReady('http://127.0.0.1:7860/health', imageHealthReady), 'http://127.0.0.1:7860/health');

  process.stdout.write('Mirabilis doctor report:\n');
  for (const c of checks) {
    const tag = c.ok ? '[OK]' : (c.required ? '[FAIL]' : '[WARN]');
    process.stdout.write(`  ${tag} ${c.name} - ${c.detail}\n`);
  }

  process.stdout.write(`  [INFO] thread count default - ${detectThreadCount()}\n`);
  process.stdout.write(`  [INFO] run state file - ${RUN_STATE_PATH}\n`);

  const failed = checks.filter((c) => !c.ok && c.required).length;
  const warned = checks.filter((c) => !c.ok && !c.required).length;
  if (failed > 0) {
    process.stdout.write(
      `Doctor found ${failed} problem(s)${warned ? ` and ${warned} note(s)` : ''}. Run: node run.js install\n`
    );
    process.exitCode = 1;
  } else if (warned > 0) {
    process.stdout.write(
      `Doctor found no problems. ${warned} note(s) above are optional components or services that are simply not running.\n`
    );
  } else {
    process.stdout.write('Doctor completed successfully.\n');
  }
}

async function runLogs() {
  const logFiles = {
    backend: path.join(os.tmpdir(), 'backend.log'),
    frontend: path.join(os.tmpdir(), 'frontend.log'),
    image: path.join(os.tmpdir(), 'image-service.log')
  };

  statusLine('INFO', 'Tailing logs (Ctrl+C to stop)...');
  process.stdout.write('\n');

  const tails = {};
  let allReady = false;

  // Start tail for each log file
  Object.entries(logFiles).forEach(([name, logPath]) => {
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, '');
    }

    const tail = spawn('tail', ['-f', logPath]);
    tails[name] = tail;

    tail.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => {
        process.stdout.write(`[${name.toUpperCase()}] ${line}\n`);
      });
    });

    tail.stderr.on('data', (data) => {
      process.stderr.write(`[${name.toUpperCase()}] ERROR: ${data.toString()}\n`);
    });

    tail.on('close', (code) => {
      if (code !== 0 && code !== null) {
        statusLine('WARN', `${name} tail stopped (exit ${code})`);
      }
    });
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    Object.values(tails).forEach(tail => {
      if (tail && !tail.killed) {
        try { tail.kill('SIGTERM'); } catch { /* ignore */ }
      }
    });
    process.stdout.write('\nLogs stopped.\n');
    process.exit(0);
  });
}

function cleanup() {
  for (const key of ['backend', 'frontend', 'image', 'llama', 'kobold']) {
    if (managed[key] && !managed[key].killed) {
      try { managed[key].kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
  if (ollamaStartedByScript && managed.ollama && !managed.ollama.killed) {
    try { managed.ollama.kill('SIGTERM'); } catch { /* ignore */ }
  }
  void clearRunState();
}

async function main() {
  const { mode, arg, extraArgs, logEnabled, verbose, devUi, prodUi } = parseArgs(process.argv.slice(2));
  const uiDevMode = devUi && !prodUi;
  process.env.MIRABILIS_LOG = logEnabled ? '1' : '0';
  process.env.MIRABILIS_VERBOSE = verbose ? '1' : '0';
  process.env.MIRABILIS_DEV_UI = uiDevMode ? '1' : '0';

  if (mode === '-h' || mode === '--help') {
    usage();
    return;
  }

  if (mode === 'doctor') {
    await runDoctor();
    return;
  }

  if (mode === 'logs') {
    await runLogs();
    return;
  }

  if (mode === 'install') {
    await withPhase('Install', runInstall);
    return;
  }

  if (mode === 'uninstall') {
    await runUninstall();
    return;
  }

  if (mode === 'stop') {
    await stopAll();
    return;
  }

  const isRestart = mode === 'restart';
  const providerCandidate = isRestart ? (arg || 'ui') : mode;
  const provider = normalizeProvider(providerCandidate);
  if (!provider) {
    process.stderr.write('Unknown mode/provider. Use one of: ui, ollama, openai-compatible, koboldcpp, stop, restart, doctor, logs, install, uninstall\n');
    usage();
    process.exit(1);
  }

  if (isRestart) {
    section('Restart');
    statusLine('INFO', `Requested provider=${provider}`);
    await stopAll();
  }

  // Check if deps exist, auto-install if missing
  let depsExist = true;
  try {
    ensureDeps();
  } catch {
    depsExist = false;
  }

  if (!depsExist) {
    statusLine('INFO', 'Dependencies missing. Running auto-install...');
    await withPhase('Install', runInstall);
  }

  await withPhase('Preflight', async () => {
    ensureDeps();
    if (!uiDevMode && !hasFrontendBuild()) {
      statusLine('INFO', 'Frontend production build missing. Running npm run build...');
      const buildCode = await runForeground(npmCommand(), npmArgs(['run', 'build']), FRONTEND_DIR);
      if (buildCode !== 0) {
        throw new Error('Frontend build failed. Run: cd frontend && npm run build');
      }
    }
    await ensureImageServicePythonDeps();
    if (verbose) {
      statusLine('INFO', `Node: ${process.version}`);
      statusLine('INFO', `Threads: ${detectThreadCount()}`);
      statusLine('INFO', `Mode: ${provider}`);
      statusLine('INFO', `Frontend mode: ${uiDevMode ? 'dev' : 'production'}`);
    }
  });

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  const threads = detectThreadCount();
  let aiProvider = 'ollama';
  const env = { ...process.env, PORT: '4000' };

  await withPhase('Providers', async () => {
    if (provider === 'ui') {
      statusLine('INFO', 'Starting Mirabilis with provider selection in UI');
      if (!(await ensureOllamaReady())) throw new Error('Ollama is not available and could not be started. Install Ollama and run node run.js.');
      if (!(await ensureOllamaModel())) throw new Error('Could not ensure an Ollama model is available.');

      let openaiReady = false;
      let koboldReady = false;

      try {
        if (await startOpenAICompatible(threads)) {
          env.OPENAI_BASE_URL = 'http://127.0.0.1:8000/v1';
          openaiReady = true;
        }
      } catch {
        openaiReady = false;
      }

      try {
        if (await startKoboldCpp(threads)) {
          env.KOBOLD_BASE_URL = 'http://127.0.0.1:5001/v1';
          koboldReady = true;
        }
      } catch {
        koboldReady = false;
      }

      statusLine('INFO', `Provider status: ollama=ready openai-compatible=${openaiReady ? 'ready' : 'unavailable'} koboldcpp=${koboldReady ? 'ready' : 'unavailable'}`);
    } else if (provider === 'ollama') {
      statusLine('INFO', 'Using Ollama provider');
      if (!(await ensureOllamaReady())) throw new Error('Ollama is not available and could not be started. Install Ollama and run node run.js.');
      if (!(await ensureOllamaModel())) throw new Error('Could not ensure an Ollama model is available.');
      aiProvider = 'ollama';
    } else if (provider === 'openai-compatible') {
      statusLine('INFO', 'Using OpenAI-compatible provider');
      if (await startOpenAICompatible(threads)) {
        aiProvider = 'openai-compatible';
        env.OPENAI_BASE_URL = 'http://127.0.0.1:8000/v1';
      } else {
        statusLine('WARN', 'OpenAI-compatible failed; falling back to Ollama');
        aiProvider = 'ollama';
        if (!(await ensureOllamaReady())) throw new Error('Ollama is also unavailable. Start Ollama or run node run.js.');
        await ensureOllamaModel();
      }
    } else if (provider === 'koboldcpp') {
      statusLine('INFO', 'Using KoboldCpp provider');
      if (await startKoboldCpp(threads)) {
        aiProvider = 'koboldcpp';
        env.KOBOLD_BASE_URL = 'http://127.0.0.1:5001/v1';
      } else {
        statusLine('WARN', 'KoboldCpp failed; falling back to Ollama');
        aiProvider = 'ollama';
        if (!(await ensureOllamaReady())) throw new Error('Ollama is also unavailable. Start Ollama or run node run.js.');
        await ensureOllamaModel();
      }
    }
  });

  env.AI_PROVIDER = aiProvider;

  await withPhase('Services', async () => {
    const backendLogFile = path.join(os.tmpdir(), 'backend.log');
    managed.backend = await ensureServiceRunning({
      label: 'Backend',
      url: 'http://127.0.0.1:4000/health',
      timeoutMs: 45000,
      logFile: backendLogFile,
      spawnService: () => spawnLogged(npmCommand(), npmArgs(['run', 'dev']), BACKEND_DIR, env, backendLogFile, logEnabled)
    });
    statusLine('OK', 'Backend: http://127.0.0.1:4000');
    await writeRunState({ provider: aiProvider, logging: logEnabled });

    const frontendLogFile = path.join(os.tmpdir(), 'frontend.log');
    const frontendScript = uiDevMode ? 'dev' : 'start';
    const frontendEnv = uiDevMode
      ? { ...process.env, PORT: '3000' }
      : { ...process.env, PORT: '3000', NODE_ENV: 'production' };
    const frontendOwner = await classifyFrontendPortOwner(3000);
    if (frontendOwner.kind === 'other-mirabilis') {
      const terminated = await terminateStaleMirabilisFrontendOnPort(3000);
      if (terminated > 0) {
        statusLine('WARN', `Port 3000 had stale Mirabilis frontend from another workspace; terminated ${terminated} process(es)`);
      }
    } else if (frontendOwner.kind === 'foreign') {
      const sample = frontendOwner.sample ? `\n  Occupant: ${frontendOwner.sample}` : '';
      throw new Error(`Port 3000 is occupied by a non-Mirabilis process. Stop that process or free port 3000.${sample}`);
    }

    try {
      managed.frontend = await ensureServiceRunning({
        label: 'Frontend',
        url: 'http://127.0.0.1:3000',
        timeoutMs: 60000,
        logFile: frontendLogFile,
        spawnService: () => spawnLogged(npmCommand(), npmArgs(['run', frontendScript]), FRONTEND_DIR, frontendEnv, frontendLogFile, false)
      });
    } catch (error) {
      const message = String(error?.message || '');
      const hasPortConflictHint = /eaddrinuse|address already in use|frontend exited with code 0/i.test(message);
      const frontendReady = await endpointReady('http://127.0.0.1:3000');

      if (frontendReady) {
        // Frontend came up despite the error (race with exit-code-0); treat as running.
        managed.frontend = null;
      } else if (hasPortConflictHint) {
        const terminated = await terminateStaleMirabilisFrontendOnPort(3000);
        if (terminated > 0) {
          statusLine('WARN', `Frontend port 3000 was occupied by stale Mirabilis process(es); cleaned ${terminated} and retrying once`);
          managed.frontend = await ensureServiceRunning({
            label: 'Frontend',
            url: 'http://127.0.0.1:3000',
            timeoutMs: 60000,
            logFile: frontendLogFile,
            spawnService: () => spawnLogged(npmCommand(), npmArgs(['run', frontendScript]), FRONTEND_DIR, frontendEnv, frontendLogFile, false)
          });
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
    statusLine('OK', 'Frontend: http://127.0.0.1:3000');
    await writeRunState({ provider: aiProvider, logging: logEnabled });

    // The image service (Stable Diffusion) is OPTIONAL - only image generation
    // needs it, and its first run downloads multi-GB model assets. Do NOT block
    // the launcher on it: chat and every other feature are ready right now, so we
    // start it in the background and let it warm up. Set MIRABILIS_SKIP_IMAGE=1
    // to skip it entirely, or MIRABILIS_WAIT_IMAGE=1 to restore the old blocking
    // wait (e.g. for a headless setup that must have image generation ready).
    const imageEnv = { ...process.env, IMAGE_SERVICE_PORT: '7860', PYTHONUNBUFFERED: '1' };
    const imageLogFile = path.join(os.tmpdir(), 'image-service.log');
    if (skipImageService()) {
      statusLine('INFO', 'Image service skipped (--no-image / MIRABILIS_SKIP_IMAGE). Image generation is disabled; everything else works.');
    } else if (await endpointReady('http://127.0.0.1:7860/health', imageHealthReady)) {
      managed.image = null;
      statusLine('INFO', 'Image service already running; reusing existing service.');
    } else if (process.env.MIRABILIS_WAIT_IMAGE === '1') {
      const imageStartupTimeoutMs = Number(process.env.IMAGE_SERVICE_STARTUP_TIMEOUT_MS || 900000);
      statusLine('INFO', `Waiting for image service readiness (timeout ${Math.round(imageStartupTimeoutMs / 1000)}s). First run may download model assets.`);
      statusLine('INFO', `Image service logs: ${imageLogFile}`);
      managed.image = await ensureServiceRunning({
        label: 'Image service',
        url: 'http://127.0.0.1:7860/health',
        timeoutMs: imageStartupTimeoutMs,
        logFile: imageLogFile,
        validate: imageHealthReady,
        spawnService: () => spawnLogged(imagePythonPath(), ['-u', 'server.py'], IMAGE_SERVICE_DIR, imageEnv, imageLogFile, false)
      });
      statusLine('OK', 'Image service: http://127.0.0.1:7860');
    } else {
      try {
        managed.image = spawnLogged(imagePythonPath(), ['-u', 'server.py'], IMAGE_SERVICE_DIR, imageEnv, imageLogFile, false);
        statusLine('INFO', 'Image service starting in the background (first run downloads model assets; image generation becomes available once it is ready).');
        statusLine('INFO', `Image service logs: ${imageLogFile}`);
      } catch (imageError) {
        statusLine('WARN', `Image service could not start: ${imageError?.message || imageError}. Image generation is disabled; everything else works.`);
      }
    }
    await writeRunState({ provider: aiProvider, logging: logEnabled });
  });

  printStartupSummary(aiProvider, verbose);
  if (provider === 'ui') {
    statusLine('INFO', 'Select provider from the UI settings panel.');
  }
  const activeManaged = [managed.backend, managed.frontend, managed.image].filter(Boolean);
  if (activeManaged.length === 0) {
    statusLine('INFO', 'All services were already running and were reused.');
    statusLine('INFO', 'To stop services, run: node run.js stop');
    if (process.platform === 'win32') {
      statusLine('INFO', 'On Windows, this launcher exits after reuse, so Ctrl+C here will not stop reused services.');
    }
  } else {
    statusLine('INFO', 'Press Ctrl+C to stop.');
    statusLine('INFO', 'Tip: you can also stop all Mirabilis services with: node run.js stop');
  }
  process.stdout.write('\n');

  if (activeManaged.length === 0) {
    return;
  }

  await new Promise((resolve) => {
    let exited = 0;
    const onExit = () => {
      exited += 1;
      if (exited >= activeManaged.length) resolve();
    };
    for (const proc of activeManaged) {
      proc.on('exit', onExit);
    }
  });
}

main().catch((error) => {
  statusLine('FAIL', error.message || 'Launcher failed');
  statusLine('INFO', 'Try: node run.js doctor');
  cleanup();
  process.exit(1);
});
