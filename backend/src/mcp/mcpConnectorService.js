import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

function normalizeUrl(url) {
  const value = String(url || '').trim();
  if (!value) {
    throw new Error('url is required');
  }
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only http/https MCP endpoints are currently supported');
    }
    return parsed.toString();
  } catch {
    throw new Error('Invalid MCP server URL');
  }
}

function nowIso() {
  return new Date().toISOString();
}

function requestId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeToolPolicy(input = {}, fallback = null) {
  const source = input && typeof input === 'object' ? input : {};
  const base = fallback && typeof fallback === 'object' ? fallback : {};

  const enforceAllowlist = source.enforceAllowlist == null
    ? (base.enforceAllowlist != null ? !!base.enforceAllowlist : false)
    : !!source.enforceAllowlist;

  const requireApproval = source.requireApproval == null
    ? (base.requireApproval != null ? !!base.requireApproval : true)
    : !!source.requireApproval;

  const ttlRaw = source.approvalTtlSeconds == null
    ? (base.approvalTtlSeconds != null ? base.approvalTtlSeconds : 300)
    : source.approvalTtlSeconds;
  const approvalTtlSeconds = Math.max(30, Math.min(Number(ttlRaw) || 300, 3600));

  const allowedInput = source.allowedTools != null ? source.allowedTools : base.allowedTools;
  const allowedTools = Array.isArray(allowedInput)
    ? Array.from(new Set(allowedInput.map((name) => String(name || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b))
    : [];

  return {
    enforceAllowlist,
    requireApproval,
    approvalTtlSeconds,
    allowedTools
  };
}

function sanitizeServer(input) {
  const id = String(input.id || '').trim();
  const name = String(input.name || '').trim();
  const transport = String(input.transport || 'streamable-http').trim();

  if (!id) {
    throw new Error('id is required');
  }
  if (!name) {
    throw new Error('name is required');
  }
  if (transport !== 'streamable-http') {
    throw new Error('Only transport "streamable-http" is currently supported');
  }

  return {
    id,
    name,
    url: normalizeUrl(input.url),
    transport,
    enabled: input.enabled !== false,
    authToken: input.authToken ? String(input.authToken) : '',
    toolPolicy: normalizeToolPolicy(input.toolPolicy),
    createdAt: input.createdAt || nowIso(),
    updatedAt: nowIso()
  };
}

function summarizeServer(server) {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    transport: server.transport,
    enabled: !!server.enabled,
    hasAuthToken: !!server.authToken,
    toolPolicy: normalizeToolPolicy(server.toolPolicy),
    createdAt: server.createdAt,
    updatedAt: server.updatedAt
  };
}

function tryParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonRpcFromSse(raw) {
  const events = String(raw || '').split(/\r?\n\r?\n/);
  const messages = [];

  for (const block of events) {
    const lines = block.split(/\r?\n/);
    let data = '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const piece = line.slice(5).trimStart();
      data = data ? `${data}\n${piece}` : piece;
    }
    const parsed = tryParseJson(data);
    if (parsed && typeof parsed === 'object') {
      messages.push(parsed);
    }
  }

  return messages;
}

function parseMcpResponse(raw, method) {
  const direct = tryParseJson(raw);
  if (direct && typeof direct === 'object') {
    if (direct.error) {
      throw new Error(`${method} failed: ${direct.error.message || 'Unknown MCP error'}`);
    }
    return direct.result || {};
  }

  const fromSse = extractJsonRpcFromSse(raw);
  if (fromSse.length > 0) {
    const withError = fromSse.find((msg) => msg && msg.error);
    if (withError) {
      throw new Error(`${method} failed: ${withError.error.message || 'Unknown MCP error'}`);
    }
    const withResult = fromSse.find((msg) => msg && Object.prototype.hasOwnProperty.call(msg, 'result'));
    if (withResult) {
      return withResult.result || {};
    }
  }

  throw new Error(`MCP response was not valid JSON: ${String(raw || '').slice(0, 300)}`);
}

async function postJsonRpc(server, method, params = {}, timeoutMs = 15000, sessionId = '') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  };

  if (server.authToken) {
    headers.Authorization = `Bearer ${server.authToken}`;
  }
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  const body = {
    jsonrpc: '2.0',
    id: requestId(),
    method,
    params
  };

  try {
    const response = await fetch(server.url, {
      method: 'POST',
      redirect: 'follow',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${raw || 'no response body'}`);
    }

    const result = parseMcpResponse(raw, method);
    const nextSessionId = response.headers.get('mcp-session-id') || sessionId || '';
    return { result, sessionId: nextSessionId };
  } finally {
    clearTimeout(timer);
  }
}

export class McpConnectorService {
  constructor(options) {
    this.filePath = options.filePath;
    this.clientInfo = {
      name: options.clientName || 'mirabilis',
      version: options.clientVersion || '26.2R1-S3'
    };
    this.state = {
      servers: []
    };
    // Cache initialized session IDs per server to avoid redundant handshakes and
    // ensure stateful MCP servers receive tool calls on the same session.
    this._sessionCache = new Map(); // serverId -> { sessionId, expiresAt }
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.state.servers = Array.isArray(parsed.servers)
        ? parsed.servers.map((server) => ({
            ...server,
            toolPolicy: normalizeToolPolicy(server.toolPolicy)
          }))
        : [];
    } catch {
      this.state.servers = [];
      await this.persist();
    }
  }

  async persist() {
    await writeFile(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  listServers() {
    return this.state.servers.map(summarizeServer);
  }

  getServer(id) {
    const key = String(id || '').trim();
    return this.state.servers.find((server) => server.id === key) || null;
  }

  async upsertServer(input) {
    const candidate = sanitizeServer(input);
    const existing = this.getServer(candidate.id);

    if (existing) {
      existing.name = candidate.name;
      existing.url = candidate.url;
      existing.transport = candidate.transport;
      existing.enabled = candidate.enabled;
      existing.authToken = candidate.authToken;
      existing.toolPolicy = normalizeToolPolicy(input.toolPolicy, existing.toolPolicy);
      existing.updatedAt = nowIso();
      this._sessionCache.delete(existing.id); // URL/auth changed, force re-init
      await this.persist();
      return summarizeServer(existing);
    }

    this.state.servers.push(candidate);
    await this.persist();
    return summarizeServer(candidate);
  }

  async removeServer(id) {
    const key = String(id || '').trim();
    const before = this.state.servers.length;
    this.state.servers = this.state.servers.filter((server) => server.id !== key);
    if (this.state.servers.length === before) {
      return false;
    }
    this._sessionCache.delete(key);
    await this.persist();
    return true;
  }

  getServerPolicy(id) {
    const server = this.getServer(id);
    if (!server) {
      throw new Error('MCP server not found');
    }
    return normalizeToolPolicy(server.toolPolicy);
  }

  async setServerPolicy(id, policy) {
    const server = this.getServer(id);
    if (!server) {
      throw new Error('MCP server not found');
    }
    server.toolPolicy = normalizeToolPolicy(policy, server.toolPolicy);
    server.updatedAt = nowIso();
    await this.persist();
    return normalizeToolPolicy(server.toolPolicy);
  }

  async initializeServer(id, timeoutMs = 15000) {
    const server = this.getServer(id);
    if (!server) {
      throw new Error('MCP server not found');
    }
    if (!server.enabled) {
      throw new Error('MCP server is disabled');
    }

    const initResponse = await postJsonRpc(
      server,
      'initialize',
      {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this.clientInfo
      },
      timeoutMs
    );
    const sessionId = initResponse?.sessionId || '';

    try {
      await postJsonRpc(server, 'notifications/initialized', {}, timeoutMs, sessionId);
    } catch {
      // Some servers are fine without this acknowledgement.
    }

    return {
      server: summarizeServer(server),
      initialize: initResponse?.result || {},
      sessionId
    };
  }

  async testServer(id, timeoutMs = 15000) {
    const init = await this.initializeServer(id, timeoutMs);
    return {
      ok: true,
      server: init.server,
      initialize: init.initialize,
      checkedAt: nowIso()
    };
  }

  async _ensureSession(id, timeoutMs) {
    const cached = this._sessionCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.sessionId;
    }
    const init = await this.initializeServer(id, timeoutMs);
    this._sessionCache.set(id, { sessionId: init.sessionId, expiresAt: Date.now() + 300_000 });
    return init.sessionId;
  }

  async listTools(id, timeoutMs = 15000) {
    const sessionId = await this._ensureSession(id, timeoutMs);
    const server = this.getServer(id);
    const response = await postJsonRpc(server, 'tools/list', {}, timeoutMs, sessionId || '');
    return {
      tools: Array.isArray(response?.result?.tools) ? response.result.tools : [],
      raw: response?.result || {}
    };
  }

  async callTool(id, name, args = {}, timeoutMs = 30000) {
    const toolName = String(name || '').trim();
    if (!toolName) {
      throw new Error('tool name is required');
    }
    if (args && typeof args !== 'object') {
      throw new Error('tool arguments must be an object');
    }

    const init = await this._ensureSession(id, timeoutMs);
    const server = this.getServer(id);
    const response = await postJsonRpc(
      server,
      'tools/call',
      {
        name: toolName,
        arguments: args || {}
      },
      timeoutMs,
      init || ''
    );

    return response?.result || {};
  }
}
