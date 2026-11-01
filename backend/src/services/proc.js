// @ts-check
// Child-process helpers shared by the chat and IntelLedger paths.

import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/** Is `command` on PATH? */
/** @param {string} command @returns {Promise<boolean>} */
export async function commandExists(command) {
  const probe = process.platform === 'win32' ? `where ${command}` : `command -v ${command}`;
  try {
    await execAsync(probe, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a command to completion, capturing stdout/stderr.
 * Always bounded by a timeout so a hung tool cannot stall the single-slot media queue.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string,string>, timeoutMs?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function runCommand(command, args, { cwd, env, timeoutMs = 1000 * 60 * 10, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error(`${command} aborted before it started`)); return; }
    // detached gives the child its own process group. Forked children outlive a
    // plain proc.kill, so stopping a run signals the whole group.
    const proc = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });

    /**
     * SIGTERM the group, then SIGKILL survivors, and always release the pipes.
     * A grandchild can escape the group (dash and bash differ) while holding
     * stdout/stderr, which would keep this event loop alive. Destroying the
     * streams leaves it an orphan instead.
     */
    const killGroup = () => {
      const pid = proc.pid;
      if (pid != null) {
        try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone, or not a group leader */ }
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        setTimeout(() => {
          try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }, 2000).unref?.();
      }
      try { proc.stdout?.destroy(); } catch { /* already closed */ }
      try { proc.stderr?.destroy(); } catch { /* already closed */ }
      try { proc.unref(); } catch { /* nothing to release */ }
    };

    const onAbort = () => {
      killGroup();
      reject(new Error(`${command} was cancelled`));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const detach = () => { if (signal) signal.removeEventListener('abort', onAbort); };

    let stdout = '';
    let stderr = '';
    const timeout = timeoutMs > 0 ? setTimeout(() => {
      killGroup();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs) : null;

    proc.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (error) => {
      if (timeout) clearTimeout(timeout);
      detach();
      reject(error);
    });
    proc.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      detach();
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`);
      // Test runners (cargo, npm, pytest) print failures on stdout, so attach it.
      Object.assign(error, { exitCode: code, stdout, stderr });
      reject(error);
    });
  });
}

/** Decode any media file to the 16kHz mono PCM WAV that Whisper expects. */
/** @param {string} inputPath @param {string} outputPath @param {number} [timeoutMs] */
export async function extractAudioTrack(inputPath, outputPath, timeoutMs = 1000 * 60 * 10) {
  await runCommand('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    outputPath
  ], { timeoutMs });
  return outputPath;
}
