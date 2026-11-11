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
Settings, Connectors, "Use Mirabilis from other apps" shows the endpoint, the
token and a config snippet to copy.
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

## Connectors (client)

Connectors are MCP servers Mirabilis starts or calls, so agent runs can use
their tools. Manage them in Settings, Connectors.

### Adding one

- Catalog: ready-made servers. Filesystem, Memory, Sequential Thinking and
  Everything (a reference server for testing) run with `npx`; Git, Fetch and
  Time with `uvx` (install uv first); Junos with `python3` (clone
  https://github.com/Juniper/junos-mcp-server and `pip install -r
  requirements.txt` first). The catalog says which launchers are installed.
- Local command: any stdio server, as a command, arguments, `KEY=value`
  environment lines and a working folder. `~` means your home folder.
- Remote URL: a streamable HTTP server, with an optional bearer token.

Enabled connectors start when the backend starts, in the background. A local
connector is a child process: Mirabilis widens its `PATH` with the Homebrew and
user tool folders (an app started from the Dock gets a minimal one), passes a
short list of environment variables plus the connector's own, restarts it at
most 3 times in 5 minutes after a crash, and stops its whole process group on
disable, remove or shutdown. The last 300 lines of its output are under View
logs.

### Tool permissions

Each tool has a permission: Allow, Ask or Off. A tool its server marks
read-only (`readOnlyHint`) starts at Allow, every other tool at Ask.

| Access level | Allow | Ask | Off |
|---|---|---|---|
| Chat only | not offered | not offered | not offered |
| Read only | runs if the tool is read-only, else not offered | same | not offered |
| Ask first | runs | asks you first | not offered |
| Bypass | runs | runs | not offered |

Agents see a tool as `<connector>__<tool>`. "Always allow" on an approval sets
that tool to Allow. Calling a tool yourself from the connector's detail view
counts as the approval, so Ask tools run; Off tools never do.

### Go Dark

Remote connectors to hosts outside this machine and the local network stop
with "Blocked by Go Dark" and reconnect when Go Dark goes off. Local connectors
keep running; network use inside them (Fetch, Junos) is up to them, and the
catalog marks those.

### Storage and API

Connectors are saved in `<data-dir>/connectors.json` (see
[CONFIGURATION.md](CONFIGURATION.md)). On first start, HTTP servers from an
older `mcp-servers.json` are imported once: an `authToken` becomes an
`Authorization: Bearer` header, a server that required approval gets Ask on
every tool, and an enforced allowlist turns the other tools Off.

All routes need the session token:

| Route | Does |
|---|---|
| `GET /api/connectors` | List connectors with status and tools. Secret values are never returned, only their names. |
| `GET /api/connectors/catalog` | The catalog, with `available` per entry. |
| `POST /api/connectors` | Add `{ presetId, fields }` or a custom connector. |
| `PATCH /api/connectors/:id` | Rename, enable, change the command or URL, or set `tools: { name: "allow" \| "ask" \| "off" }`. |
| `DELETE /api/connectors/:id` | Remove and stop it. |
| `POST /api/connectors/:id/restart` | Restart it. |
| `GET /api/connectors/:id/logs` | Its last output lines. |
| `POST /api/connectors/:id/tools/:tool/call` | Call a tool with `{ args }`. |
