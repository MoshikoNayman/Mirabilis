import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiFetch } from './api.js';
import {
  normalizeConnector, normalizePreset, connectorStatus, connectorSubtitle, connectorKind, commandLine,
  monogram, parseLines, parseEnvLines, buildCustomConnector, presetFieldValues, presetInitialValues,
  presetFieldsError, presetCommandPreview, groupPresets, requirementInfo, isLocalUrl,
  mirabilisMcpUrl, maskToken, clientSnippet, fetchMcpEndpoint, saveMcpEndpoint
} from './connectors.js';

// Only the request helper is replaced; API_BASE and the rest of api.js stay real.
vi.mock('./api.js', async (importOriginal) => ({ ...(await importOriginal()), apiFetch: vi.fn() }));

describe('normalizeConnector', () => {
  it('fills every field from an empty payload', () => {
    const c = normalizeConnector(undefined);
    expect(c.status.state).toBe('off');
    expect(c.tools).toEqual([]);
    expect(c.args).toEqual([]);
    expect(c.name).not.toBe('');
  });

  it('defaults tool permissions by the read-only hint', () => {
    const c = normalizeConnector({
      id: 'a', name: 'A', enabled: true, status: { state: 'ready' },
      tools: [{ name: 'read', readOnly: true }, { name: 'write' }, { name: 'x', permission: 'off' }, { title: 'no name' }]
    });
    expect(c.tools.map((t) => [t.name, t.permission])).toEqual([['read', 'allow'], ['write', 'ask'], ['x', 'off']]);
    expect(c.status.toolCount).toBe(3);
  });

  it('reports a disabled connector as off and keeps only key names', () => {
    const c = normalizeConnector({ enabled: false, status: { state: 'ready' }, env: { API_KEY: 'secret' }, headerKeys: ['Authorization'] });
    expect(c.status.state).toBe('off');
    expect(c.envKeys).toEqual(['API_KEY']);
    expect(c.headerKeys).toEqual(['Authorization']);
    expect(JSON.stringify(c)).not.toContain('secret');
  });
});

describe('connectorStatus', () => {
  const make = (state, extra = {}) => normalizeConnector({ enabled: true, status: { state, ...extra } });

  it('labels each state', () => {
    expect(connectorStatus(make('ready', { toolCount: 4 }))).toEqual({ label: 'Connected, 4 tools', tone: 'success' });
    expect(connectorStatus(make('ready', { toolCount: 1 })).label).toBe('Connected, 1 tool');
    expect(connectorStatus(make('starting')).label).toBe('Starting');
    expect(connectorStatus(make('error')).tone).toBe('danger');
    expect(connectorStatus(make('off')).label).toBe('Stopped');
    expect(connectorStatus(normalizeConnector({ enabled: false, status: { state: 'ready' } })).label).toBe('Off');
  });
});

describe('connectorKind', () => {
  const http = (url) => normalizeConnector({ transport: 'http', url });

  it('calls a command Local', () => {
    expect(connectorKind(normalizeConnector({ transport: 'stdio', command: 'python3' }))).toBe('Local');
    expect(connectorKind(normalizeConnector({ command: 'npx' }))).toBe('Local');
  });

  it('calls a server on this computer Local URL', () => {
    for (const url of ['http://127.0.0.1:30030/mcp', 'http://localhost:4000/mcp', 'http://LocalHost/mcp', 'http://[::1]:30030/mcp']) {
      expect(connectorKind(http(url)), url).toBe('Local URL');
    }
  });

  it('calls every other URL Remote', () => {
    for (const url of ['https://mcp.example.com/mcp', 'http://192.168.1.101:30030/mcp', 'http://localhost.example.com/mcp', 'not a url', '']) {
      expect(connectorKind(http(url)), url).toBe('Remote');
    }
  });
});

describe('subtitle and command line', () => {
  it('shows the command for local connectors and the host for URL ones', () => {
    const local = normalizeConnector({ transport: 'stdio', command: 'npx', args: ['-y', 'pkg', '/My Files'] });
    expect(connectorSubtitle(local)).toEqual({ kind: 'Local', detail: 'npx -y pkg "/My Files"' });
    const remote = normalizeConnector({ transport: 'http', url: 'https://mcp.example.com:8443/mcp' });
    expect(connectorSubtitle(remote)).toEqual({ kind: 'Remote', detail: 'mcp.example.com:8443' });
    const loopback = normalizeConnector({ transport: 'http', url: 'http://127.0.0.1:30030/mcp' });
    expect(connectorSubtitle(loopback)).toEqual({ kind: 'Local URL', detail: '127.0.0.1:30030' });
  });

  it('quotes arguments that need it', () => {
    expect(commandLine('echo', ['a b', 'say "hi"', ''])).toBe('echo "a b" "say \\"hi\\"" ""');
  });
});

describe('monogram', () => {
  it('uses initials of the first two words, or the first two letters', () => {
    expect(monogram('Junos MCP')).toBe('JM');
    expect(monogram('sequential-thinking')).toBe('ST');
    expect(monogram('filesystem')).toBe('FI');
    expect(monogram('')).toBe('?');
  });
});

describe('form parsing', () => {
  it('splits arguments one per line', () => {
    expect(parseLines(' -y \n\n@pkg/server \r\n')).toEqual(['-y', '@pkg/server']);
  });

  it('parses KEY=value lines and rejects bad ones', () => {
    expect(parseEnvLines('A=1\n# note\n\nB_2=x=y')).toEqual({ env: { A: '1', B_2: 'x=y' }, error: '' });
    expect(parseEnvLines('novalue').error).toMatch(/line 1/);
    expect(parseEnvLines('ok=1\n9BAD=2').error).toMatch(/line 2/);
  });

  it('builds a local command connector', () => {
    const { input, error } = buildCustomConnector({
      transport: 'stdio', name: ' Memory ', command: 'npx', args: '-y\n@modelcontextprotocol/server-memory',
      env: 'DEBUG=1', cwd: '~/work', url: '', token: ''
    });
    expect(error).toBe('');
    expect(input).toEqual({
      name: 'Memory', transport: 'stdio', command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'], env: { DEBUG: '1' }, cwd: '~/work'
    });
  });

  it('builds a remote connector and does not double the Bearer prefix', () => {
    const base = { transport: 'http', name: 'Remote', command: '', args: '', env: '', cwd: '' };
    const { input } = buildCustomConnector({ ...base, url: 'https://x.example/mcp', token: 'Bearer abc' });
    expect(input?.headers).toEqual({ Authorization: 'Bearer abc' });
    const noToken = buildCustomConnector({ ...base, url: 'http://127.0.0.1:9000/mcp', token: '' });
    expect(noToken.input?.headers).toEqual({});
  });

  it('explains what is missing', () => {
    const base = { transport: 'stdio', name: 'X', command: '', args: '', env: '', cwd: '', url: '', token: '' };
    expect(buildCustomConnector({ ...base, name: '' }).error).toMatch(/name/);
    expect(buildCustomConnector({ ...base, name: 'x'.repeat(61) }).error).toMatch(/name/);
    expect(buildCustomConnector(base).error).toMatch(/command/);
    expect(buildCustomConnector({ ...base, transport: 'http', url: 'ftp://x' }).error).toMatch(/http/);
  });
});

describe('presets', () => {
  const fs = normalizePreset({
    id: 'filesystem', name: 'Filesystem', category: 'Files', command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '{folders}'],
    fields: [{ key: 'folders', label: 'Folders', kind: 'paths', required: true }],
    requires: 'npx', available: true
  });

  it('drops presets without an id and unsafe docs links', () => {
    expect(normalizePreset({ name: 'x' })).toBeNull();
    expect(normalizePreset({ id: 'a', docsUrl: 'javascript:alert(1)' })?.docsUrl).toBe('');
    expect(normalizePreset({ id: 'a', docsUrl: 'https://github.com/x' })?.docsUrl).toBe('https://github.com/x');
  });

  it('turns paths fields into lists and requires required fields', () => {
    expect(presetFieldValues(fs, { folders: '~/Documents\n\n~/Projects' })).toEqual({ folders: ['~/Documents', '~/Projects'] });
    expect(presetFieldsError(fs, { folders: '  ' })).toMatch(/Folders/);
    expect(presetFieldsError(fs, { folders: '~/x' })).toBe('');
  });

  it('starts the form from values found on this machine', () => {
    const junos = /** @type {any} */ (normalizePreset({
      id: 'junos', name: 'Junos', category: 'Network', command: 'python3',
      fields: [
        { key: 'folder', label: 'Server folder', kind: 'path', required: true, default: '~/junos-mcp-server' },
        { key: 'devices', label: 'Devices file', kind: 'path', required: false },
        { key: 'odd', label: 'Odd', kind: 'text', default: 7 }
      ]
    }));
    expect(junos.fields.map((f) => f.default)).toEqual(['~/junos-mcp-server', '', '']);
    const values = presetInitialValues(junos);
    expect(values).toEqual({ folder: '~/junos-mcp-server' });
    expect(presetFieldsError(junos, values)).toBe('');
    expect(presetFieldValues(junos, values)).toEqual({ folder: '~/junos-mcp-server' });
    expect(presetInitialValues(fs)).toEqual({});
  });

  it('previews the command with placeholders filled', () => {
    expect(presetCommandPreview(fs, { folders: '~/A\n~/B' })).toBe('npx -y @modelcontextprotocol/server-filesystem ~/A ~/B');
    expect(presetCommandPreview(fs, {})).toContain('<folders>');
  });

  it('fills placeholders in the command as well as the arguments', () => {
    const venv = normalizePreset({
      id: 'v', command: '{folder}/.venv/bin/python', args: ['{folder}/jmcp.py', '-t', 'stdio'],
      fields: [{ key: 'folder', label: 'Server folder', kind: 'path', required: true }]
    });
    expect(presetCommandPreview(venv, { folder: '~/srv' })).toBe('~/srv/.venv/bin/python ~/srv/jmcp.py -t stdio');
    expect(presetCommandPreview(venv, {})).toContain('<server folder>/.venv/bin/python');
  });

  it('groups by category in a fixed order', () => {
    const list = ['Utilities', 'Network', 'Files', 'Other', 'Developer'].map((category, i) => normalizePreset({ id: `p${i}`, category }));
    const groups = groupPresets(/** @type {any} */ (list));
    expect(groups.map((g) => g.category)).toEqual(['Files', 'Developer', 'Network', 'Utilities', 'Other']);
  });

  it('names what is missing for unavailable presets', () => {
    expect(requirementInfo('uvx').label).toBe('uv');
    expect(requirementInfo('npx').label).toBe('Node.js');
    expect(requirementInfo('python3').label).toBe('Python 3');
    expect(requirementInfo('weird').url).toBe('');
  });
});

describe('isLocalUrl', () => {
  it('matches loopback and private LAN hosts like the backend', () => {
    for (const ok of ['http://localhost:3000', 'http://127.0.0.1/mcp', 'http://[::1]:4000', 'http://10.1.2.3', 'http://192.168.1.101', 'http://172.20.0.5', 'http://nas.local']) {
      expect(isLocalUrl(ok), ok).toBe(true);
    }
    for (const no of ['https://example.com', 'http://172.32.0.1', 'http://169.254.169.254', 'not a url', '']) {
      expect(isLocalUrl(no), no).toBe(false);
    }
  });
});

describe('use from other apps', () => {
  it('spells out 127.0.0.1 for the MCP endpoint', () => {
    expect(mirabilisMcpUrl('http://localhost:4000')).toBe('http://127.0.0.1:4000/mcp');
    expect(mirabilisMcpUrl('http://localhost:4000/')).toBe('http://127.0.0.1:4000/mcp');
    expect(mirabilisMcpUrl('http://192.168.1.5:4000')).toBe('http://192.168.1.5:4000/mcp');
    expect(mirabilisMcpUrl('http://localhostile.example')).toBe('http://localhostile.example/mcp');
  });

  it('masks all but the ends of the token', () => {
    const t = 'abcd' + 'x'.repeat(40) + 'wxyz';
    const masked = maskToken(t);
    expect(masked.startsWith('abcd')).toBe(true);
    expect(masked.endsWith('wxyz')).toBe(true);
    expect(masked).not.toContain('xxxx');
    expect(maskToken('short')).toBe('*****');
  });

  it('builds a working snippet for each client', () => {
    const url = 'http://127.0.0.1:4000/mcp';
    expect(clientSnippet('claude-code', url, 'T')).toBe(
      'claude mcp add --transport http mirabilis http://127.0.0.1:4000/mcp --header "Authorization: Bearer T"'
    );
    expect(JSON.parse(clientSnippet('cursor', url, 'T'))).toEqual({
      mcpServers: { mirabilis: { url, headers: { Authorization: 'Bearer T' } } }
    });
    expect(JSON.parse(clientSnippet('vscode', url, 'T'))).toEqual({
      servers: { mirabilis: { type: 'http', url, headers: { Authorization: 'Bearer T' } } }
    });
  });
});

describe('Mirabilis MCP server switch', () => {
  const request = vi.mocked(apiFetch);
  beforeEach(() => { request.mockReset(); });

  it('reads the switch, on unless the backend says off', async () => {
    request.mockResolvedValueOnce({ enabled: false, path: '/mcp', tools: ['mirabilis_chat', 7, '', 'read_file'] });
    expect(await fetchMcpEndpoint()).toEqual({ enabled: false, path: '/mcp', tools: ['mirabilis_chat', 'read_file'] });
    expect(request).toHaveBeenLastCalledWith('/api/mcp-endpoint', { signal: undefined });
    request.mockResolvedValueOnce({});
    expect(await fetchMcpEndpoint()).toEqual({ enabled: true, path: '/mcp', tools: [] });
  });

  it('saves with PUT and returns what the backend stored', async () => {
    request.mockResolvedValueOnce({ enabled: false, path: '/mcp', tools: [] });
    expect((await saveMcpEndpoint({ enabled: false })).enabled).toBe(false);
    expect(request).toHaveBeenLastCalledWith('/api/mcp-endpoint', { method: 'PUT', body: { enabled: false } });
    request.mockResolvedValueOnce({ enabled: true });
    expect((await saveMcpEndpoint({ enabled: true })).enabled).toBe(true);
    expect(request).toHaveBeenLastCalledWith('/api/mcp-endpoint', { method: 'PUT', body: { enabled: true } });
  });

  it('rejects on a backend without the route, so the pane can hide the switch', async () => {
    request.mockRejectedValueOnce(new Error('Mirabilis returned a non-JSON response (404).'));
    await expect(fetchMcpEndpoint()).rejects.toThrow(/404/);
  });
});
