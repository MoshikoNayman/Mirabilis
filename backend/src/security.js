// Network attack-surface guards. These are defense-in-depth ON TOP of the
// loopback bind (config.bindHost). None of them touch model behaviour or add any
// content restriction - they govern who can reach the API and where the server
// is willing to make outbound requests.

import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

// ── Host-header guard (anti-DNS-rebinding) ──────────────────────────────────
// A malicious web page can point its own hostname at 127.0.0.1 (DNS rebinding)
// and make the victim's browser hit this server. Every such request carries the
// attacker's hostname in the Host header; a real local client sends localhost /
// 127.0.0.1. Rejecting foreign Host values closes that path for all routes.
export function makeHostGuard(allowedHostnames) {
  const allow = new Set(allowedHostnames.map((h) => h.toLowerCase()));
  return function hostGuard(req, res, next) {
    const raw = req.headers.host;
    // Some non-browser tools omit Host; loopback bind already limits reach, so
    // allow the empty case rather than break legitimate local automation.
    if (!raw) return next();
    // Strip port; handle bracketed IPv6 (e.g. [::1]:4000).
    let hostname = String(raw).trim().toLowerCase();
    if (hostname.startsWith('[')) hostname = hostname.slice(1, hostname.indexOf(']'));
    else hostname = hostname.split(':')[0];
    if (allow.has(hostname)) return next();
    res.status(403).json({ error: 'Host not allowed', host: hostname });
  };
}

// ── Local token for the machine-facing /mcp surface ─────────────────────────
// /mcp exposes run_command/write_file/read_file to external MCP clients
// (VS Code, Claude Desktop). It must not be callable by just any local process.
// We mint a per-install token, persist it 0600, and require it as a bearer.
export function loadOrCreateMcpToken(tokenPath, envToken) {
  if (envToken && envToken.trim()) return envToken.trim();
  try {
    if (existsSync(tokenPath)) {
      const existing = readFileSync(tokenPath, 'utf8').trim();
      if (existing) return existing;
    }
  } catch { /* fall through to regenerate */ }
  const token = randomBytes(24).toString('hex');
  try {
    writeFileSync(tokenPath, token, { mode: 0o600 });
  } catch { /* non-fatal: token still enforced in-memory for this run */ }
  return token;
}

export function makeMcpAuthGuard(expectedToken) {
  return function mcpAuthGuard(req, res, next) {
    const auth = String(req.headers.authorization || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const header = String(req.headers['x-mirabilis-mcp-token'] || '').trim();
    const provided = bearer || header;
    if (provided && provided === expectedToken) return next();
    res.status(401).json({
      error: 'Unauthorized: /mcp requires the local Mirabilis MCP token. ' +
        'Copy it from the startup log or backend/data/mcp-token into your MCP client config ' +
        '(Authorization: Bearer <token>).'
    });
  };
}

// ── Outbound SSRF guard (cloud metadata only) ───────────────────────────────
// Local AI legitimately targets loopback (Ollama, llama-server) and the user's
// own LAN hosts, so we deliberately do NOT block private ranges. We block only
// the cloud metadata endpoints, which are never a legitimate provider and are
// the classic SSRF target.
const METADATA_HOSTS = new Set([
  '169.254.169.254',       // AWS/GCP/Azure IMDS
  'metadata.google.internal',
  'metadata',
  '100.100.100.200',       // Alibaba Cloud
  'fd00:ec2::254',         // AWS IMDSv2 IPv6
]);

export function isBlockedProviderHost(urlString) {
  let hostname;
  try {
    hostname = new URL(urlString).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false; // not our job to validate malformed URLs; callers handle that
  }
  return METADATA_HOSTS.has(hostname);
}

export function assertSafeProviderUrl(urlString) {
  if (isBlockedProviderHost(urlString)) {
    throw new Error('Refusing to reach a cloud metadata endpoint.');
  }
}
