#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT_DIR = __dirname;
const BACKEND_DIR = path.join(ROOT_DIR, 'backend');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');
const IMAGE_SERVICE_DIR = path.join(ROOT_DIR, 'image-service');
const PROVIDERS_DIR = path.join(ROOT_DIR, 'providers');
const MODEL_PATH = path.join(os.tmpdir(), 'mirabilis-llama-3.2-1b-instruct-q4_k_m.gguf');

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
  process.stdout.write(`Usage: ./run.sh [provider] [--log]\n\nProviders:\n  ui                 - Start app and choose provider from UI (default)\n  ollama             - Use Ollama provider\n  openai-compatible  - Use llama-server as OpenAI-compatible provider\n  koboldcpp          - Use KoboldCpp provider\n  stop               - Stop all Mirabilis/provider processes\n\nFlags:\n  --log              - Print live backend/MCP logs to terminal and write audit files\n\nEnvironment:\n  MIRABILIS_THREADS  - Override CPU threads for llama-server/koboldcpp (default: all logical cores)\n\nExample:\n  ./run.sh\n  ./run.sh ollama\n  ./run.sh openai-compatible --log\n  ./run.sh stop\n\n`);
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
  const provider = filtered[0] || 'ui';
  return { provider, logEnabled };
}

function normalizeProvider(raw) {
  const value = String(raw || 'ui').toLowerCase();
  if (['ui', 'ollama', 'openai-compatible', 'koboldcpp', 'stop'].includes(value)) {
    return value;
  }
  return '';
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
  const checker = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [cmd] : ['-v', cmd];
  return new Promise((resolve) => {
    const child = spawn(checker, args, { stdio: 'ignore', shell: process.platform !== 'win32' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function endpointReady(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
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
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok || !res.body) {
      throw new Error('Failed to download llama model.');
    }
    const tempPath = `${modelPath}.tmp`;
    const out = fs.createWriteStream(tempPath);
    await new Promise((resolve, reject) => {
      res.body.pipe(out);
      res.body.on('error', reject);
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

  await ensureLlamaModel(MODEL_PATH);
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

  await ensureLlamaModel(MODEL_PATH);
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

async function stopAll() {
  process.stdout.write('Stopping Mirabilis and provider processes...\n');
  if (process.platform === 'win32') {
    await runForeground('taskkill', ['/F', '/IM', 'node.exe'], ROOT_DIR);
    await runForeground('taskkill', ['/F', '/IM', 'python.exe'], ROOT_DIR);
    await runForeground('taskkill', ['/F', '/IM', 'llama-server.exe'], ROOT_DIR);
    await runForeground('taskkill', ['/F', '/IM', 'koboldcpp.exe'], ROOT_DIR);
    await runForeground('taskkill', ['/F', '/IM', 'ollama.exe'], ROOT_DIR);
  } else {
    await runForeground('pkill', ['-f', 'node --watch src/server.js|next dev|python server.py|llama-server|koboldcpp|ollama serve'], ROOT_DIR);
  }
  process.stdout.write('Stopped\n');
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
}

async function main() {
  const { provider: rawProvider, logEnabled } = parseArgs(process.argv.slice(2));
  process.env.MIRABILIS_LOG = logEnabled ? '1' : '0';

  if (rawProvider === '-h' || rawProvider === '--help') {
    usage();
    return;
  }

  const provider = normalizeProvider(rawProvider);
  if (!provider) {
    process.stderr.write('Unknown provider. Use one of: ui, ollama, openai-compatible, koboldcpp, stop\n');
    usage();
    process.exit(1);
  }

  if (provider === 'stop') {
    await stopAll();
    return;
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
  managed.backend = spawnLogged('npm', ['run', 'dev'], BACKEND_DIR, env, path.join(os.tmpdir(), 'backend.log'), logEnabled);
  await sleep(2000);
  process.stdout.write('  Backend: http://127.0.0.1:4000\n');

  managed.frontend = spawnLogged('npm', ['run', 'dev'], FRONTEND_DIR, { ...process.env, PORT: '3000' }, path.join(os.tmpdir(), 'frontend.log'), false);
  await sleep(3000);
  process.stdout.write('  Frontend: http://127.0.0.1:3000\n');

  const imageEnv = { ...process.env, IMAGE_SERVICE_PORT: '7860' };
  managed.image = spawnLogged(imagePythonPath(), ['server.py'], IMAGE_SERVICE_DIR, imageEnv, path.join(os.tmpdir(), 'image-service.log'), false);
  await sleep(2000);
  process.stdout.write('  Image Service: http://127.0.0.1:7860\n');

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
