# MCP

Mirabilis is both an MCP server, so other tools can use it, and an MCP client,
so it can use other servers.

## Server

Endpoint (streamable HTTP):

```
POST http://127.0.0.1:4000/mcp
```

| Tool | What it does |
|---|---|
| `mirabilis_chat` | Send a prompt, get a streamed reply; provider and model selectable |
| `mirabilis_list_models` | List models for a provider |
| `mirabilis_health` | Readiness of the configured providers |
| `system_info` | OS, platform, architecture, hostname, home dir, cwd |
| `list_dir` | List a directory |
| `read_file` | Read a text file, up to 512 KB |
| `write_file` | Write or overwrite a file; requires `confirmed: true` |
| `run_command` | Run a shell command, 30 s timeout; requires `confirmed: true` |

The file tools go through the agent's path jail and `run_command` through its
destructive-command blocklist. Set `MIRABILIS_MCP_FS_ROOT` to confine the file
tools and the command working directory to one subtree; it does not limit what a
shell command can reach once running.

### Token

`/mcp` requires a local bearer token because it can write files and run
commands. The token is generated on first start and saved to
`<data-dir>/mcp-token`; the startup log prints its first characters and that
path. Set `MIRABILIS_MCP_TOKEN` to choose it yourself.

Send it as `Authorization: Bearer <token>` (or `x-mirabilis-mcp-token`).
Requests without it get `401`. The backend also binds to loopback and rejects
foreign `Host` headers by default.

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "mirabilis": {
      "url": "http://127.0.0.1:4000/mcp",
      "headers": { "Authorization": "Bearer <token>" },
      "description": "Mirabilis local AI - start with node run.js first"
    }
  }
}
```

### Logs

- Audit log: `node run.js --log` (or `MIRABILIS_LOG=1`) prints each request and
  tool call and appends to `<data-dir>/mcp-server-audit.jsonl`.
- Change journal: always on. Before `write_file` overwrites a file its old
  contents are saved under `<data-dir>/mcp-change-journal/snapshots/`, and every
  write and command is appended to `mcp-change-journal/journal.jsonl`.

## Client

The MCP panel in the UI connects to external MCP servers over HTTP or HTTPS.
Connections are saved in `<data-dir>/mcp-servers.json`.

Each server has a tool policy:

| Setting | Default | Meaning |
|---|---|---|
| `requireApproval` | on | Ask before a tool call runs |
| `approvalTtlSeconds` | 300 | How long an approval lasts (30 to 3600) |
| `enforceAllowlist` | off | Only allow tools in `allowedTools` |
| `allowedTools` | empty | Tool names permitted when the allowlist is enforced |
