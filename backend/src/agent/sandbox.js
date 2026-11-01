// @ts-check
// The one destructive-command blocklist and path jail, shared by the MCP server
// and the autonomous agent. Do not fork a second copy.

import { resolve, normalize, sep, dirname } from 'node:path';
import { realpathSync } from 'node:fs';

// Never run, at any effort level or confirmation. This matches shell strings, so
// it cannot catch every spelling (`cd / && rm -rf .`); granting the 'full' policy
// still grants a shell.
export const BLOCKED_COMMAND_PATTERNS = [
  // Recursive rm, flags in any order with any options between.
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
 * The root is read per call so tests and stricter runs can change it.
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

  // Compare real paths: a symlink inside the root can point anywhere. For a file
  // that does not exist yet, check the nearest existing ancestor, where the write lands.
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
