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

// Same token check, applied to the app's OWN privileged routes rather than /mcp.
// These endpoints run shell commands over SSH, read and write arbitrary
// workspace paths, and index folders from disk. Before this guard they were
// reachable by anything that knew the port: the host guard blocks a foreign Host
// header and CORS blocks a browser on another origin, but neither stops a plain
// local HTTP client. The app's own UI gets the token from GET /api/session/token,
// which answers only loopback requests carrying an allowed Origin.
/** @param {string} expectedToken @param {string} label */
export function makePrivilegedGuard(expectedToken, label) {
  return function privilegedGuard(req, res, next) {
    const auth = String(req.headers.authorization || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const header = String(req.headers['x-mirabilis-mcp-token'] || '').trim();
    const provided = bearer || header;
    if (provided && provided === expectedToken) return next();
    res.status(401).json({
      error: `Unauthorized: ${label} is a privileged local route and requires the Mirabilis session token. ` +
        'The app sends it automatically. To call this route directly, send ' +
        'Authorization: Bearer <token> using the token file named in the startup log.'
    });
  };
}

// Is this URL served by a host on the user's own machine or LAN?
//
// Go Dark and the Privacy Receipt both need to answer "does this leave the
// device", and the provider ID cannot answer it: openai-compatible, vllm and
// llamacpp all take an arbitrary base URL, so the same provider ID can point at
// localhost or at a cloud endpoint. Decide from the resolved host instead.
// Loopback and RFC1918 private ranges count as local; anything else does not.
// An unparseable or empty URL is treated as NOT local, so the safe answer wins.
/** @param {string} url @returns {boolean} */
export function isLocalHostUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return false;
  let host;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '[::1]') return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127) return true;                          // loopback
  if (a === 10) return true;                           // 10.0.0.0/8
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  if (a === 169 && b === 254) return false;            // link-local: not a trusted LAN peer
  return false;
}

// True only for requests that arrived over loopback. Used to gate the token
// bootstrap route, so the token is never handed to a non-local caller even if
// the server has been bound more widely.
/** @param {import('express').Request} req */
export function isLoopbackRequest(req) {
  const raw = String(req.socket?.remoteAddress || '');
  // Node reports IPv4-mapped IPv6 as ::ffff:127.0.0.1
  const addr = raw.replace(/^::ffff:/, '');
  return addr === '127.0.0.1' || addr === '::1' || addr.startsWith('127.');
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
