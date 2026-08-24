// @ts-check
// backend/src/agent/sandbox.js
// Safety primitives shared by the MCP server and the autonomous agent.
//
// Extracted so there is exactly ONE destructive-command blocklist and ONE path
// jail. These are the rules that decide whether an unattended process can wipe a
// disk, so a second divergent copy is the last thing this code should grow. The
// agent needs them far more than the MCP server does: an MCP call is driven by a
// human on the other end, whereas an agent on the five-hour tier can issue
// thousands of commands with nobody watching.

import { resolve, normalize, sep, dirname } from 'node:path';
import { realpathSync } from 'node:fs';

// Patterns that are never run, at any effort level, with any confirmation.
//
// Read this as a seatbelt, not a sandbox. It pattern-matches a shell string,
// and a shell string has unlimited ways to say the same thing: the earlier
// version anchored the rm target on a leading / or ~, so `cd / && rm -rf .`,
// `rm -rf $HOME` and `rm -rf --no-preserve-root /` all walked straight through.
// The patterns below close the ones worth closing, but granting the 'full'
// policy is still granting a shell. The real containment is not granting it.
export const BLOCKED_COMMAND_PATTERNS = [
  // Recursive force-delete of any obviously catastrophic target, with flags in
  // any order and any number of intervening options.
  /\brm\b[^\n;|&]*\s-[a-z-]*r/i,
  /\brm\b[^\n;|&]*--no-preserve-root/i,
  // Whole-filesystem walks that delete or truncate.
  /\bfind\b\s+\/\s+[^\n]*-(delete|exec\s+rm)\b/i,
  /mkfs(\.\w+)?\s/i,                              // mkfs.ext4 /dev/...
  /\bdd\b[^\n]*\bof=\/dev\//i,                    // dd of=/dev/sda (disk wipe)
  /\bdd\s+if=/i,                                   // dd if=... (legacy pattern)
  /format\s+[a-z]:/i,                              // format C: (Windows)
  /:\s*\(\s*\)\s*\{.*\|.*&.*\}/,                   // fork bomb
  /\b(shutdown|reboot|halt|poweroff)\b/i,          // system power ops
  /\bchmod\b[^\n]*\s-[a-z-]*R[^\n]*\s\/(\s|$)/,      // chmod -R ... / (recursive on root)
  />\s*\/dev\/(sd|nvme|disk)/i                     // redirect over a raw device
];

/** @param {string} command */
export function isSafeCommand(command) {
  return !BLOCKED_COMMAND_PATTERNS.some((re) => re.test(command));
}

/**
 * Optional filesystem jail. By default the tools operate system-wide (the
 * advertised "system control" capability, reachable only with the local token).
 * MIRABILIS_MCP_FS_ROOT confines read/write/list to one subtree.
 */
export function getFsRoot() {
  return process.env.MIRABILIS_MCP_FS_ROOT
    ? resolve(String(process.env.MIRABILIS_MCP_FS_ROOT))
    : null;
}

/**
 * Resolve a caller-supplied path, refusing anything that escapes the jail.
 * Read at call time rather than captured at import, so a test (or a run with a
 * tighter root) can set the jail without re-importing the module.
 * @param {string} inputPath
 * @param {string} [rootOverride] a stricter root for this particular run
 */
export function safeResolvePath(inputPath, rootOverride) {
  const jail = rootOverride ? resolve(rootOverride) : getFsRoot();
  const cleaned = normalize(String(inputPath || '').replace(/\0/g, ''));
  const resolved = resolve(jail || process.cwd(), cleaned);
  if (!jail) return resolved;

  const lexicalOk = resolved === jail || resolved.startsWith(jail + sep);
  if (!lexicalOk) {
    throw new Error(`Path escapes the permitted filesystem root (${jail})`);
  }

  // Lexical containment is not containment. A single symlink inside the root
  // (a convenience link to an external volume, say) made the whole filesystem
  // reachable while every path still looked confined. Compare REAL paths.
  // For a file that does not exist yet, resolve the nearest existing ancestor,
  // since that is what the write will actually land under.
  try {
    const realJail = realpathSync(jail);
    let probe = resolved;
    for (;;) {
      try {
        const realProbe = realpathSync(probe);
        const suffix = resolved.slice(probe.length);
        const realTarget = realProbe + suffix;
        if (realTarget !== realJail && !realTarget.startsWith(realJail + sep)) {
          throw new Error(`Path escapes the permitted filesystem root via a symlink (${jail})`);
        }
        return resolved;
      } catch (err) {
        if (err && /escapes the permitted/.test(String(err.message))) throw err;
        const parent = dirname(probe);
        if (parent === probe) return resolved; // nothing on disk to check against
        probe = parent;
      }
    }
  } catch (err) {
    if (err && /escapes the permitted/.test(String(err.message))) throw err;
    return resolved; // realpath unavailable: lexical check already passed
  }
}
