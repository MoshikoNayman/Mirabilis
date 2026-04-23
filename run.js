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
    INFO: color('INFO', '36')
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
  process.stdout.write(`Usage: node run.js [provider|command] [args] [--log] [--verbose]\n\nProviders:\n  ui                 - Start app and choose provider from UI (default)\n  ollama             - Use Ollama provider\n  openai-compatible  - Use llama-server as OpenAI-compatible provider\n  koboldcpp          - Use KoboldCpp provider\n\nCommands:\n  stop               - Stop processes started by launcher (PID-based); fallback to pattern kill if needed\n  restart [provider] - Stop then start again (provider optional, default: ui)\n  doctor             - Validate environment, binaries, and service reachability\n  logs               - Tail live logs from backend, frontend, and image-service\n  install            - Install dependencies (pure JavaScript, no shell needed)\n  uninstall          - Remove dependencies and caches\n\nFlags:\n  --log              - Print live backend/MCP logs to terminal and write audit files\n  --verbose          - Print richer launch diagnostics and phase summaries\n\nEnvironment:\n  MIRABILIS_THREADS  - Override CPU threads for llama-server/koboldcpp (default: all logical cores)\n\nExample:\n  node run.js\n  node run.js ollama\n  node run.js openai-compatible --log --verbose\n  node run.js doctor\n  node run.js logs\n  node run.js restart koboldcpp --log\n  node run.js install\n  node run.js uninstall\n  node run.js stop\n\n`);
}

function parseArgs(argv) {
  let logEnabled = false;
  let verbose = false;
  const filtered = [];
  for (const arg of argv) {
    if (arg === '--log') {
      logEnabled = true;
    } else if (arg === '--verbose') {
      verbose = true;
    } else {
      filtered.push(arg);
    }
  }
  const mode = filtered[0] || 'ui';
  const arg = filtered[1] || '';
  const extraArgs = filtered.slice(1);
  return { mode, arg, extraArgs, logEnabled, verbose };
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

async function endpointReady(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForEndpoint(url, timeoutMs, label, processObj, logFile) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await endpointReady(url)) return;
    // Check if process crashed
    if (processObj && processObj.exitCode !== null) {
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
  throw new Error(`${label} did not become ready at ${url}`);
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
    { module: 'flask', pkg: 'flask' }
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

  statusLine('INFO', 'No Ollama models found — pulling qwen2.5:0.5b (one-time, ~400MB)...');
  const code = await runForeground(ollamaBin, ['pull', 'qwen2.5:0.5b'], ROOT_DIR);
  if (code === 0) statusLine('OK', 'Ollama default model ready');
  return code === 0;
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
    process.stderr.write('llama-server not found. Run: node run.js install\n');
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
    process.stderr.write('koboldcpp not found. Run: node run.js install\n');
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
  statusLine('INFO', 'Ollama not found — attempting auto-install...');
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

  // Check Ollama — auto-install if missing
  if (!(await hasOllamaCommand())) {
    await installOllama();
  }
  statusLine('OK', 'Ollama: installed');

  // Ensure Ollama service is running so we can check/pull models
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

  // Ensure at least one Ollama model is available — pull default if none
  await ensureOllamaModel();

  // Install backend
  statusLine('INFO', 'Installing backend dependencies...');
  const backendCode = await runForeground(npmCommand(), npmArgs(['install', '--legacy-peer-deps']), BACKEND_DIR);
  if (backendCode !== 0) {
    throw new Error('Backend npm install failed');
  }

  // Install frontend
  statusLine('INFO', 'Installing frontend dependencies...');
  const frontendCode = await runForeground(npmCommand(), npmArgs(['install', '--legacy-peer-deps']), FRONTEND_DIR);
  if (frontendCode !== 0) {
    throw new Error('Frontend npm install failed');
  }

  // Setup Python venv
  statusLine('INFO', 'Setting up Python environment...');
  const venvPath = path.join(IMAGE_SERVICE_DIR, '.venv');
  if (!fs.existsSync(venvPath)) {
    const venvCode = await runForeground('python3', ['-m', 'venv', venvPath], IMAGE_SERVICE_DIR);
    if (venvCode !== 0) {
      throw new Error('Python venv creation failed');
    }
  }

  const pythonExe = imagePythonPath();
  const pipCode = await runForeground(pythonExe, ['-m', 'pip', 'install', '-q', '--upgrade', 'pip'], IMAGE_SERVICE_DIR);
  if (pipCode !== 0) {
    throw new Error('pip upgrade failed');
  }

  const reqsCode = await runForeground(pythonExe, ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt'], IMAGE_SERVICE_DIR);
  if (reqsCode !== 0) {
    throw new Error('Python requirements install failed');
  }

  // Provider binaries (macOS only for auto-install)
  if (process.platform === 'darwin') {
    statusLine('INFO', 'Installing provider runtimes (macOS detected)...');
    // Ensure providers directory exists
    if (!fs.existsSync(PROVIDERS_DIR)) {
      fs.mkdirSync(PROVIDERS_DIR, { recursive: true });
    }
    const arch = process.arch;

    // llama-server
    if (!fs.existsSync(path.join(PROVIDERS_DIR, 'llama-server'))) {
      statusLine('INFO', 'Installing llama-server...');
      const llamaUrl = arch === 'arm64'
        ? 'https://github.com/ggerganov/llama.cpp/releases/download/b3920/llama-b3920-bin-macos-arm64.zip'
        : 'https://github.com/ggerganov/llama.cpp/releases/download/b3920/llama-b3920-bin-macos-x64.zip';
      
      const zipPath = path.join(PROVIDERS_DIR, 'llama.zip');
      const res = await fetch(llamaUrl);
      if (!res.ok) throw new Error('Failed to download llama-server');
      const buf = await res.arrayBuffer();
      await fsp.writeFile(zipPath, Buffer.from(buf));

      const { execSync } = require('child_process');
      try {
        execSync(`cd "${PROVIDERS_DIR}" && unzip -qo llama.zip`, { stdio: 'inherit' });
      } catch {
        throw new Error('llama-server extraction failed');
      }

      if (fs.existsSync(path.join(PROVIDERS_DIR, 'build', 'bin', 'llama-server'))) {
        fs.renameSync(path.join(PROVIDERS_DIR, 'build', 'bin', 'llama-server'), path.join(PROVIDERS_DIR, 'llama-server'));
      }
      if (fs.existsSync(path.join(PROVIDERS_DIR, 'build', 'bin', 'llama-cli'))) {
        fs.renameSync(path.join(PROVIDERS_DIR, 'build', 'bin', 'llama-cli'), path.join(PROVIDERS_DIR, 'llama-cli'));
      }
      execSync(`rm -rf "${path.join(PROVIDERS_DIR, 'build')}" "${zipPath}"`, { stdio: 'ignore' });
      fs.chmodSync(path.join(PROVIDERS_DIR, 'llama-server'), 0o755);
      statusLine('OK', 'llama-server installed');
    } else {
      statusLine('OK', 'llama-server already exists');
    }

    // koboldcpp
    if (!fs.existsSync(path.join(PROVIDERS_DIR, 'koboldcpp'))) {
      if (arch === 'arm64') {
        statusLine('INFO', 'Installing KoboldCpp...');
        const releaseUrl = 'https://api.github.com/repos/LostRuins/koboldcpp/releases/latest';
        const releaseRes = await fetch(releaseUrl);
        const release = await releaseRes.json();
        const asset = release.assets?.find(a => a.name === 'koboldcpp-mac-arm64');
        if (!asset) throw new Error('KoboldCpp release asset not found');

        const koboldRes = await fetch(asset.browser_download_url);
        if (!koboldRes.ok) throw new Error('Failed to download KoboldCpp');
        const koboldBuf = await koboldRes.arrayBuffer();
        await fsp.writeFile(path.join(PROVIDERS_DIR, 'koboldcpp'), Buffer.from(koboldBuf));
        fs.chmodSync(path.join(PROVIDERS_DIR, 'koboldcpp'), 0o755);
        statusLine('OK', 'koboldcpp installed');
      } else {
        statusLine('WARN', 'KoboldCpp auto-install only supports macOS arm64');
      }
    } else {
      statusLine('OK', 'koboldcpp already exists');
    }
  } else {
    statusLine('WARN', 'Non-macOS detected. Provider runtime auto-install skipped.');
    // Ensure providers directory exists anyway (for manual installs)
    if (!fs.existsSync(PROVIDERS_DIR)) {
      fs.mkdirSync(PROVIDERS_DIR, { recursive: true });
    }
  }

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

  if (!fs.existsSync(imagePythonPath())) {
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
    process.stdout.write('No active PID state found; using fallback pattern stop.\n');
    if (process.platform === 'win32') {
      await runForeground('taskkill', ['/F', '/IM', 'llama-server.exe'], ROOT_DIR);
      await runForeground('taskkill', ['/F', '/IM', 'koboldcpp.exe'], ROOT_DIR);
      await runForeground('taskkill', ['/F', '/IM', 'ollama.exe'], ROOT_DIR);
      await runForeground('taskkill', ['/F', '/IM', 'python.exe'], ROOT_DIR);
      await runForeground('taskkill', ['/F', '/IM', 'node.exe'], ROOT_DIR);
    } else {
      await runForeground('pkill', ['-f', 'node --watch src/server.js|next dev|python server.py|llama-server|koboldcpp|ollama serve'], ROOT_DIR);
    }
  }

  await clearRunState();
  process.stdout.write('Stopped\n');
}

async function runDoctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('backend node_modules', fs.existsSync(path.join(BACKEND_DIR, 'node_modules')), path.join(BACKEND_DIR, 'node_modules'));
  add('frontend node_modules', fs.existsSync(path.join(FRONTEND_DIR, 'node_modules')), path.join(FRONTEND_DIR, 'node_modules'));

  const pyPath = imagePythonPath();
  add('image-service python venv', fs.existsSync(pyPath), pyPath);

  const llamaBin = path.join(PROVIDERS_DIR, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  const koboldBin = path.join(PROVIDERS_DIR, process.platform === 'win32' ? 'koboldcpp.exe' : 'koboldcpp');
  add('llama-server binary', fs.existsSync(llamaBin), llamaBin);
  add('koboldcpp binary', fs.existsSync(koboldBin), koboldBin);

  const hasOllama = await hasOllamaCommand();
  const ollamaBin = resolveOllamaBin();
  add('ollama command', hasOllama, hasOllama ? `available (${ollamaBin})` : 'not found');
  add('ollama endpoint', await endpointReady('http://127.0.0.1:11434/api/tags'), 'http://127.0.0.1:11434/api/tags');

  add('backend endpoint', await endpointReady('http://127.0.0.1:4000/health'), 'http://127.0.0.1:4000/health');
  add('frontend endpoint', await endpointReady('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  add('image endpoint', await endpointReady('http://127.0.0.1:7860/health'), 'http://127.0.0.1:7860/health');

  process.stdout.write('Mirabilis doctor report:\n');
  for (const c of checks) {
    process.stdout.write(`  ${c.ok ? '[OK]' : '[WARN]'} ${c.name} - ${c.detail}\n`);
  }

  process.stdout.write(`  [INFO] thread count default - ${detectThreadCount()}\n`);
  process.stdout.write(`  [INFO] run state file - ${RUN_STATE_PATH}\n`);

  const failed = checks.filter((c) => !c.ok).length;
  if (failed > 0) {
    process.stdout.write(`Doctor completed with ${failed} warning(s).\n`);
    process.exitCode = 1;
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
  const { mode, arg, extraArgs, logEnabled, verbose } = parseArgs(process.argv.slice(2));
  process.env.MIRABILIS_LOG = logEnabled ? '1' : '0';
  process.env.MIRABILIS_VERBOSE = verbose ? '1' : '0';

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
    await ensureImageServicePythonDeps();
    if (verbose) {
      statusLine('INFO', `Node: ${process.version}`);
      statusLine('INFO', `Threads: ${detectThreadCount()}`);
      statusLine('INFO', `Mode: ${provider}`);
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
    managed.backend = spawnLogged(npmCommand(), npmArgs(['run', 'dev']), BACKEND_DIR, env, backendLogFile, logEnabled);
    await waitForEndpoint('http://127.0.0.1:4000/health', 45000, 'Backend', managed.backend, backendLogFile);
    statusLine('OK', 'Backend: http://127.0.0.1:4000');
    await writeRunState({ provider: aiProvider, logging: logEnabled });

    managed.frontend = spawnLogged(npmCommand(), npmArgs(['run', 'dev']), FRONTEND_DIR, { ...process.env, PORT: '3000' }, path.join(os.tmpdir(), 'frontend.log'), false);
    await waitForEndpoint('http://127.0.0.1:3000', 60000, 'Frontend');
    statusLine('OK', 'Frontend: http://127.0.0.1:3000');
    await writeRunState({ provider: aiProvider, logging: logEnabled });

    const imageEnv = { ...process.env, IMAGE_SERVICE_PORT: '7860', PYTHONUNBUFFERED: '1' };
    const imageStartupTimeoutMs = Number(process.env.IMAGE_SERVICE_STARTUP_TIMEOUT_MS || 900000);
    statusLine('INFO', `Waiting for image service readiness (timeout ${Math.round(imageStartupTimeoutMs / 1000)}s). First run may download model assets.`);
    statusLine('INFO', `Image service logs: ${path.join(os.tmpdir(), 'image-service.log')}`);
    managed.image = spawnLogged(imagePythonPath(), ['-u', 'server.py'], IMAGE_SERVICE_DIR, imageEnv, path.join(os.tmpdir(), 'image-service.log'), true);
    await waitForEndpoint('http://127.0.0.1:7860/health', imageStartupTimeoutMs, 'Image service');
    statusLine('OK', 'Image service: http://127.0.0.1:7860');
    await writeRunState({ provider: aiProvider, logging: logEnabled });
  });

  printStartupSummary(aiProvider, verbose);
  if (provider === 'ui') {
    statusLine('INFO', 'Select provider from the UI settings panel.');
  }
  statusLine('INFO', 'Press Ctrl+C to stop.');
  process.stdout.write('\n');

  await new Promise((resolve) => {
    let exited = 0;
    const onExit = () => {
      exited += 1;
      if (exited >= 3) resolve();
    };
    managed.backend.on('exit', onExit);
    managed.frontend.on('exit', onExit);
    managed.image.on('exit', onExit);
  });
}

main().catch((error) => {
  statusLine('FAIL', error.message || 'Launcher failed');
  statusLine('INFO', 'Try: node run.js doctor');
  cleanup();
  process.exit(1);
});
