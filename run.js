#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');

const ROOT_DIR = __dirname;
const BACKEND_DIR = path.join(ROOT_DIR, 'backend');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');
const IMAGE_SERVICE_DIR = path.join(ROOT_DIR, 'image-service');
const PROVIDERS_DIR = path.join(ROOT_DIR, 'providers');
const MODEL_PATH = path.join(os.tmpdir(), 'mirabilis-llama-3.2-1b-instruct-q4_k_m.gguf');
const RUN_STATE_PATH = path.join(os.tmpdir(), 'mirabilis-run-state.json');

let ollamaStartedByScript = false;
const managed = {
  backend: null,
  frontend: null,
  image: null,
  llama: null,
  kobold: null,
  ollama: null
};

function usage() {
  process.stdout.write(`Usage: ./run.sh [provider|command] [args] [--log]\n\nProviders:\n  ui                 - Start app and choose provider from UI (default)\n  ollama             - Use Ollama provider\n  openai-compatible  - Use llama-server as OpenAI-compatible provider\n  koboldcpp          - Use KoboldCpp provider\n\nCommands:\n  stop               - Stop processes started by launcher (PID-based); fallback to pattern kill if needed\n  restart [provider] - Stop then start again (provider optional, default: ui)\n  doctor             - Validate environment, binaries, and service reachability\n  install            - Delegate to install.sh (pre-cutover compatibility path)\n  uninstall          - Delegate to uninstall.sh (pre-cutover compatibility path)\n\nFlags:\n  --log              - Print live backend/MCP logs to terminal and write audit files\n\nEnvironment:\n  MIRABILIS_THREADS  - Override CPU threads for llama-server/koboldcpp (default: all logical cores)\n\nExample:\n  ./run.sh\n  ./run.sh ollama\n  ./run.sh openai-compatible --log\n  ./run.sh doctor\n  ./run.sh restart koboldcpp --log\n  ./run.sh install\n  ./run.sh uninstall\n  ./run.sh stop\n\n`);
}

function parseArgs(argv) {
  let logEnabled = false;
  const filtered = [];
  for (const arg of argv) {
    if (arg === '--log') {
      logEnabled = true;
    } else {
      filtered.push(arg);
    }
  }
  const mode = filtered[0] || 'ui';
  const arg = filtered[1] || '';
  const extraArgs = filtered.slice(1);
  return { mode, arg, extraArgs, logEnabled };
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
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function endpointReady(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForEndpoint(url, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await endpointReady(url)) return;
    await sleep(1000);
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

function ensureDeps() {
  const missingNode = !fs.existsSync(path.join(BACKEND_DIR, 'node_modules')) || !fs.existsSync(path.join(FRONTEND_DIR, 'node_modules'));
  if (missingNode) {
    throw new Error('Dependencies not installed. Run: ./install.sh');
  }

  const venvUnix = path.join(IMAGE_SERVICE_DIR, '.venv', 'bin', 'python');
  const venvWin = path.join(IMAGE_SERVICE_DIR, '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(venvUnix) && !fs.existsSync(venvWin)) {
    throw new Error('Python environment not set up. Run: ./install.sh');
  }
}

function imagePythonPath() {
  const venvWin = path.join(IMAGE_SERVICE_DIR, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvWin)) return venvWin;
  return path.join(IMAGE_SERVICE_DIR, '.venv', 'bin', 'python');
}

async function ensureOllamaReady() {
  if (await endpointReady('http://127.0.0.1:11434/api/tags')) return true;
  if (!(await commandExists('ollama'))) return false;

  process.stdout.write('Starting Ollama service...\n');
  const out = fs.openSync(path.join(os.tmpdir(), 'ollama.log'), 'a');
  managed.ollama = spawn('ollama', ['serve'], { stdio: ['ignore', out, out] });
  ollamaStartedByScript = true;

  for (let i = 0; i < 20; i += 1) {
    if (await endpointReady('http://127.0.0.1:11434/api/tags')) return true;
    await sleep(1000);
  }
  return false;
}

async function ensureOllamaModel() {
  if (!(await commandExists('ollama'))) return false;
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(4000) });
    const body = await res.json();
    const count = Array.isArray(body?.models) ? body.models.length : 0;
    if (count >= 1) return true;
  } catch {
    // Continue to pull attempt.
  }

  process.stdout.write('No Ollama models found. Pulling qwen2.5:0.5b (one-time)...\n');
  const code = await runForeground('ollama', ['pull', 'qwen2.5:0.5b'], ROOT_DIR);
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
    process.stderr.write('llama-server not found. Run: ./install.sh\n');
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
    process.stderr.write('koboldcpp not found. Run: ./install.sh\n');
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

async function runScriptCommand(scriptName, args = []) {
  const scriptPath = path.join(ROOT_DIR, scriptName);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`${scriptName} not found at ${scriptPath}`);
  }

  const shell = process.platform === 'win32' ? 'bash' : 'bash';
  if (!(await commandExists(shell))) {
    throw new Error(`Cannot execute ${scriptName}: '${shell}' not found in PATH.`);
  }

  process.stdout.write(`Delegating to ${scriptName}...\n`);
  const code = await runForeground(shell, [scriptPath, ...args], ROOT_DIR);
  if (code !== 0) {
    throw new Error(`${scriptName} exited with code ${code}`);
  }
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

  const hasOllama = await commandExists('ollama');
  add('ollama command in PATH', hasOllama, hasOllama ? 'available' : 'not found');
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
  const { mode, arg, extraArgs, logEnabled } = parseArgs(process.argv.slice(2));
  process.env.MIRABILIS_LOG = logEnabled ? '1' : '0';

  if (mode === '-h' || mode === '--help') {
    usage();
    return;
  }

  if (mode === 'doctor') {
    await runDoctor();
    return;
  }

  if (mode === 'install') {
    await runScriptCommand('install.sh', extraArgs);
    return;
  }

  if (mode === 'uninstall') {
    await runScriptCommand('uninstall.sh', extraArgs);
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
    process.stderr.write('Unknown mode/provider. Use one of: ui, ollama, openai-compatible, koboldcpp, stop, restart, doctor, install, uninstall\n');
    usage();
    process.exit(1);
  }

  if (isRestart) {
    process.stdout.write(`Restart requested (provider=${provider})\n`);
    await stopAll();
  }

  ensureDeps();

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

  if (provider === 'ui') {
    process.stdout.write('Starting Mirabilis (choose provider from UI)\n');
    if (!(await ensureOllamaReady())) throw new Error('Ollama is not available and could not be started. Install Ollama and run ./install.sh.');
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

    process.stdout.write(`Provider status: ollama=ready openai-compatible=${openaiReady ? 'ready' : 'unavailable'} koboldcpp=${koboldReady ? 'ready' : 'unavailable'}\n`);
  } else if (provider === 'ollama') {
    process.stdout.write('Using Ollama provider\n');
    if (!(await ensureOllamaReady())) throw new Error('Ollama is not available and could not be started. Install Ollama and run ./install.sh.');
    if (!(await ensureOllamaModel())) throw new Error('Could not ensure an Ollama model is available.');
    aiProvider = 'ollama';
  } else if (provider === 'openai-compatible') {
    process.stdout.write('Using OpenAI-compatible provider\n');
    if (await startOpenAICompatible(threads)) {
      aiProvider = 'openai-compatible';
      env.OPENAI_BASE_URL = 'http://127.0.0.1:8000/v1';
    } else {
      process.stdout.write('OpenAI-compatible provider failed; falling back to Ollama\n');
      aiProvider = 'ollama';
      if (!(await ensureOllamaReady())) throw new Error('Ollama is also unavailable. Start Ollama or run ./install.sh.');
      await ensureOllamaModel();
    }
  } else if (provider === 'koboldcpp') {
    process.stdout.write('Using KoboldCpp provider\n');
    if (await startKoboldCpp(threads)) {
      aiProvider = 'koboldcpp';
      env.KOBOLD_BASE_URL = 'http://127.0.0.1:5001/v1';
    } else {
      process.stdout.write('KoboldCpp provider failed; falling back to Ollama\n');
      aiProvider = 'ollama';
      if (!(await ensureOllamaReady())) throw new Error('Ollama is also unavailable. Start Ollama or run ./install.sh.');
      await ensureOllamaModel();
    }
  }

  env.AI_PROVIDER = aiProvider;

  process.stdout.write('\nStarting services...\n');
  managed.backend = spawnLogged(npmCommand(), ['run', 'dev'], BACKEND_DIR, env, path.join(os.tmpdir(), 'backend.log'), logEnabled);
  await waitForEndpoint('http://127.0.0.1:4000/health', 45000, 'Backend');
  process.stdout.write('  Backend: http://127.0.0.1:4000\n');
  await writeRunState({ provider: aiProvider, logging: logEnabled });

  managed.frontend = spawnLogged(npmCommand(), ['run', 'dev'], FRONTEND_DIR, { ...process.env, PORT: '3000' }, path.join(os.tmpdir(), 'frontend.log'), false);
  await waitForEndpoint('http://127.0.0.1:3000', 60000, 'Frontend');
  process.stdout.write('  Frontend: http://127.0.0.1:3000\n');
  await writeRunState({ provider: aiProvider, logging: logEnabled });

  const imageEnv = { ...process.env, IMAGE_SERVICE_PORT: '7860' };
  managed.image = spawnLogged(imagePythonPath(), ['server.py'], IMAGE_SERVICE_DIR, imageEnv, path.join(os.tmpdir(), 'image-service.log'), false);
  await waitForEndpoint('http://127.0.0.1:7860/health', 240000, 'Image service');
  process.stdout.write('  Image Service: http://127.0.0.1:7860\n');
  await writeRunState({ provider: aiProvider, logging: logEnabled });

  process.stdout.write('\nMirabilis is running\n');
  process.stdout.write('Open: http://localhost:3000\n');
  process.stdout.write(`Provider: ${aiProvider}\n`);
  if (provider === 'ui') {
    process.stdout.write('Select any provider from the UI settings\n');
  }
  process.stdout.write('Press Ctrl+C to stop\n\n');

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
  process.stderr.write(`${error.message || 'Launcher failed'}\n`);
  cleanup();
  process.exit(1);
});
