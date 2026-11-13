# Configuration

Every setting is an environment variable and none is required. The backend loads
`backend/.env` at startup (dotenv); copy `backend/.env.example` there to start.
Backend defaults come from `backend/src/config.js` and the modules named below.

## Server

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4000` | Backend HTTP port. |
| `MIRABILIS_BIND_HOST` | `127.0.0.1` | Interface to bind. Keep it on loopback unless an authenticating proxy sits in front: `/mcp` and `/api/remote/*` run shell commands. The app warns at startup on `0.0.0.0`. |
| `FRONTEND_ORIGIN` | `http://localhost:3000` | Allowed browser origin for CORS. |
| `CORS_ALLOW_LOCALHOST` | `1` | `0` refuses localhost origins other than `FRONTEND_ORIGIN`. |
| `MIRABILIS_ALLOWED_HOSTS` | loopback names | Extra `Host` header values to accept, comma separated, for a named reverse proxy. Guards against DNS rebinding. |
| `TRUST_PROXY` | `loopback` | Express `trust proxy`. Change only behind a real proxy. |
| `API_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window, minimum 10000. |
| `API_RATE_LIMIT_MAX` | `300` | Requests per window, minimum 50. |
| `NODE_ENV` | (unset) | `production` hides internal error detail in API responses. |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:4000` | Backend URL the frontend calls. |

## Storage

| Variable | Default | What it does |
|---|---|---|
| `MIRABILIS_DATA_DIR` | `../mirabilis-data` beside the repo | Chats, IntelLedger, config vault, Access settings, connectors, agent run logs, MCP token, MCP server switch and model caches. |
| `DATA_DIR` | (unset) | Older alias. `MIRABILIS_DATA_DIR` wins. The desktop app sets it to its per-app data folder. |

## Providers

| Variable | Default | What it does |
|---|---|---|
| `AI_PROVIDER` | `ollama` | Provider used when a request does not name one. |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama endpoint. |
| `OLLAMA_MODEL` | `llama3` | Fallback model when none is selected and none can be listed. |
| `OLLAMA_MODELS` | `~/.ollama/models` | Ollama's model directory, read to locate GGUF blobs for llama.cpp and for the free disk space in Settings, Models. |
| `OPENAI_BASE_URL` | `http://127.0.0.1:8000/v1` | OpenAI-compatible endpoint. Defaults to a local server. |
| `OPENAI_API_KEY` | (empty) | Fallback key for OpenAI and OpenAI-compatible providers when none is set in the UI. Also used for OpenAI transcription. |
| `OPENAI_MODEL` | `model.gguf` | Model for the OpenAI-compatible provider. |
| `KOBOLD_BASE_URL` | `http://127.0.0.1:5001/v1` | KoboldCpp endpoint. |
| `KOBOLD_MODEL` | `koboldcpp` | Label for the loaded KoboldCpp model. |
| `MIRABILIS_CATALOG_URL` | `backend/models.json` on the repo's main branch | Remote suggested-model catalog, fetched at most hourly. |
| `MIRABILIS_USER_CATALOG` | `~/.mirabilis/models.json` | Your own catalog additions; wins over bundled and remote. |

## Models

Settings, Models manages Ollama models: Installed (size, loaded, update status,
delete, free disk, the Ollama version) and Discover (a search of the Ollama
library with an install button and progress). The routes are under
`/api/models` (`backend/src/routes/models.js`). Installing, canceling and
deleting need the session token; reading does not.

| Request | Host | Cached |
|---|---|---|
| Library search and a model's tags | `ollama.com` | 1 hour, in `ollama-library-cache.json` |
| Update check, one HEAD per installed model for its manifest digest | `registry.ollama.ai`, `ollama.com` | 6 hours, in `model-updates.json` |
| Latest Ollama release | `api.github.com` | 12 hours, in `model-updates.json` |

- An update check downloads nothing. A result is dropped when the model's local
  digest changes, so an updated model is checked again;
  `GET /api/models/updates?refresh=1` checks now. MCQ models are built here and
  are never checked.
- When ollama.com cannot be reached or read, the last copy is served marked
  `stale`. With nothing cached the route answers `502`.
- Go Dark makes no request: search and tags return nothing, update checks
  return the cache, an install is refused with `403`, and a download in
  progress stops. The daemon does the download, so this is checked in the route
  and the install job, not by the egress guard.
- Install jobs live in memory. Progress is overall across layers, with speed
  and time left. Cancel keeps the partial download, so the next install resumes.
  Updating a model is an install of the same name; Ollama fetches only the
  changed layers.
- Both files are written `0600`, through a temp file and a rename.

## Launcher (`run.js`)

| Variable | Default | What it does |
|---|---|---|
| `MIRABILIS_SKIP_OLLAMA` | (unset) | `1` does not install or start Ollama. Same as `--no-ollama`. |
| `MIRABILIS_ALL_ENGINES` | (unset) | `1` also starts llama-server and KoboldCpp in ui mode. Same as `--all-engines`. |
| `MIRABILIS_THREADS` | all logical cores | CPU threads for llama-server and KoboldCpp. |
| `MIRABILIS_LLAMACPP_TAG` | `b10819` | llama.cpp release the installer downloads. |
| `MIRABILIS_KOBOLDCPP_TAG` | `v1.117.1` | KoboldCpp release the installer downloads. |
| `GITHUB_TOKEN` | (unset) | Optional. Raises the GitHub API rate limit for binary downloads. |
| `MIRABILIS_LOG` | from `--log` | The launcher sets it. Starting the backend directly, `1` enables the MCP audit log and live MCP output. |
| `MIRABILIS_VERBOSE` | from `--verbose` | Set by the launcher for child processes; setting it yourself has no effect. |
| `MIRABILIS_DEV_UI` | from `--dev-ui` / `dev` | Set by the launcher for child processes; setting it yourself has no effect. |
| `NO_COLOR` | (unset) | `1` disables coloured launcher output. |

## Web search

| Variable | Default | What it does |
|---|---|---|
| `TAVILY_API_KEY` | (empty) | Enables the `www` web-search chip. Without it search is off. |
| `TAVILY_SEARCH_DEPTH` | `advanced` | `basic` or `advanced`. |

Go Dark blocks web search regardless of the key.

## Local speech to text

| Variable | Default | What it does |
|---|---|---|
| `WHISPER_CPP_BINARY` | auto-detected | Path to `whisper-cli`, `whisper-cpp` or `main`. |
| `WHISPER_CPP_MODEL` | auto-detected | Path to a `ggml-*.bin` model. |

## Inference tuning

| Variable | Default | What it does |
|---|---|---|
| `MIRABILIS_MAX_HISTORY_TOKENS` | `8000` | Ceiling on history tokens per request, minimum 400. |
| `MIRABILIS_MAX_HISTORY_MESSAGES` | `100` | Ceiling on history messages per request, minimum 6. |
| `MIRABILIS_HISTORY_CTX_FRACTION` | `0.65` | Share of the context window history may use, clamped to 0.1 to 0.9. |
| `MIRABILIS_CONTRADICTION_MODEL` | (unset) | Model for the contradiction detector. |

## Agent runs and Access

| Variable | Default | What it does |
|---|---|---|
| `MIRABILIS_MCP_FS_ROOT` | (unset, no jail) | Operator jail. Confines the agent and MCP file tools, This computer's `read_log` included, and where commands start, to one subtree, at every Access level including Bypass permissions. It does not limit what a running shell command can reach. |
| `MIRABILIS_AGENT_FANOUT_CONCURRENCY` | (unset) | Sub-agents generating at once, 1 to 8. Unset: 2 on a local engine (Ollama, llama.cpp, KoboldCpp, a Custom endpoint on this machine or LAN), which serves one request per model at a time; 8 on cloud providers, vLLM and a remote Custom endpoint. Set, it applies to every provider. |
| `MIRABILIS_AGENT_MAX_CONCURRENT_RUNS` | `2` | Runs executing at once. Each has its own budget and, above Read only, can run its own commands. |
| `MIRABILIS_MCP_TOKEN` | generated | Bearer token for `/mcp` and the privileged routes (agent runs, Access, connectors). Generated and saved to the data directory when unset. |

### Access levels

One setting decides what the assistant may do on this computer. It is saved in
`access.json` in the data folder and changed in Settings, Access (or with
`PUT /api/access`). The default is Chat only.

| Level | What a run may do |
|---|---|
| Chat only | No tools. A single-shot effort goes to the normal chat route. |
| Read only | Read files anywhere, inspect the system, run commands that are proven read-only, use connector tools their server marks read-only. Never changes anything and never asks. |
| Ask first | Everything Read only does, freely. Anything that changes something, or is not known to be read-only, pauses until you allow or deny it. |
| Bypass permissions | Everything, with no approvals, no command blocklist and no folder jail. |

- A run's request may lower the saved level, never raise it. Lowering the saved
  level while a run is going applies to its next tool call.
- Read-only means proven: a command is split on `|`, `&&`, `||` and `;`, any
  redirection or subshell disqualifies it, and every program and its arguments
  must be on the built-in list (`ps`, `df`, `ls`, `lsof`, `git status`, `brew
  list` and so on). Settings shows the list.
- Ask first shows an approval above the composer with the exact command, the
  file and a preview, or the connector tool and its arguments. Deny can carry a
  note, which reaches the model. Waiting does not use up the run's budget.
- "Always allow" on a command saves a rule such as `git status` or `npm test`
  to `allowCommands`; rules apply in Ask first only. On a file change it allows
  changes for the rest of that run. On a connector tool it sets that tool to
  Allow.
- Bypass permissions still applies `MIRABILIS_MCP_FS_ROOT`, the work budget, the run log,
  and connector tools set to Off. Go Dark does not filter commands in Bypass permissions.
- The blocklist (recursive `rm`, `mkfs`, `dd` to a device, fork bombs,
  `shutdown`, recursive `chmod` on `/`) applies in Read only and Ask first. It
  catches accidents, not a determined prompt.
- Before any file change the old bytes are copied to
  `agent-runs/<runId>/before/` in the data folder and the copy is named in the
  run log. Copies older than 30 days are removed at startup.
- Commands run with `/bin/sh -c` (`cmd.exe /d /s /c` on Windows) as your user,
  starting in the project folder when one is set, else your home folder. They
  get your environment without the backend's own `PORT`, `NODE_ENV`,
  `ELECTRON_RUN_AS_NODE` and `MIRABILIS_MCP_TOKEN`.

Real confinement needs an OS sandbox (container, VM, Seatbelt, namespaces).

### Tiers

| Tier | Wall clock | Steps | Tool calls | Sub-agents |
|---|---|---|---|---|
| Assist (Instant to Thorough, Access above Chat only) | 10 min | 16 | 40 | none |
| High effort | 30 min | 12 | 60 | none |
| 1 hour | 60 min | 80 | 500 | up to 3 |
| Ultra | 2 hours | 160 | 1000 | up to 8, 4 by default |
| 5 hours | 5 hours | 400 | 2500 | up to 6 |

Agents in the Effort menu sets the sub-agent cap for 1 hour, 5 hours and Ultra,
from 1 (no sub-agents) to the tier limit. A request can only lower it. Ultra
splits each goal into independent parts in code, runs one agent per part,
checks each result with a pass that tries to refute it, then merges and checks
the merged answer the same way. A goal that does not split runs as one agent.
Sub-agents share the run budget on every axis, and one sub-agent cannot
overwrite a file another changed in the same split.

The budget is enforced in code. A run that hits it returns what it has plus a
note on what is left undone. Runs are held in memory, so a backend restart drops
one in flight. Small models struggle with the tool-calling format; 12B or larger
works better.

### access.json

```json
{
  "level": "ask",
  "allowCommands": ["git status", "npm test"],
  "updatedAt": "2026-11-11T12:00:00.000Z"
}
```

`level` is `chat`, `read`, `ask` or `bypass`; anything else reads as `chat`.
`allowCommands` holds up to 200 rules of 1 to 120 characters. A rule covers a
command when each part of it is read-only or starts with the rule's words;
a command with a redirection or a subshell never matches. The file is written
`0600`, through a temp file and a rename.

### connectors.json

The connectors added in Settings, Connectors. Written `0600` with a `.bak`; a
file that cannot be read is moved aside and the `.bak` used. Each entry:

```json
{
  "id": "...", "name": "Filesystem", "transport": "stdio",
  "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"],
  "env": {}, "cwd": "", "url": "", "headers": {},
  "enabled": true, "tools": { "write_file": "ask", "read_file": "allow" },
  "preset": "filesystem", "createdAt": "...", "updatedAt": "..."
}
```

`env` and `headers` hold secrets such as tokens; the API returns their names,
never their values. The Memory preset keeps its data in
`connector-memory.jsonl`. A local (`stdio`) entry is a child process of the
backend: enabled ones start with it and stop with it. A command, argument or
working folder typed with `~` is saved that way and expanded when the program
starts. A Junos entry looks like this, with `cwd` set to the server folder:

```json
{
  "name": "Junos", "transport": "stdio",
  "command": "~/junos-mcp-server/.venv/bin/python",
  "args": ["~/junos-mcp-server/jmcp.py", "-f", "~/junos-mcp-server/devices.json", "-t", "stdio"],
  "cwd": "~/junos-mcp-server", "preset": "junos"
}
```

The built-in This computer entry holds only its switch, its tool permissions
and `toolInfo`, a cache of its tool list. The first start adds it, on:

```json
{
  "id": "this-computer", "enabled": true,
  "tools": { "kill_process": "ask", "system_overview": "allow" },
  "toolInfo": { "kill_process": { "title": "...", "description": "...", "readOnly": false } }
}
```

What it runs is set at every start, never read from the file:
`backend/src/mcp/machineServer.js` on the backend's own runtime, from the home
folder, with `ELECTRON_RUN_AS_NODE=1`, `MIRABILIS_DATA_DIR` set to the data
folder (it reads `go-dark.json` there) and `MIRABILIS_MCP_FS_ROOT` when set.

See [MCP.md](MCP.md).

### mcp-endpoint.json

Whether Mirabilis's own MCP server (`POST /mcp`) is on, set with the switch in
Settings, Connectors (or with `PUT /api/mcp-endpoint`):

```json
{ "enabled": false, "updatedAt": "2026-11-11T12:00:00.000Z" }
```

Only `"enabled": false` turns it off; a missing or unreadable file means on.
While it is off, `/mcp` answers `503`. The file is written `0600`, through a
temp file and a rename.

## Image generation

| Variable | Default | What it does |
|---|---|---|
| `MIRABILIS_SKIP_IMAGE` | (unset) | `1` skips installing and starting the image service. Same as `--no-image`. |
| `MIRABILIS_SKIP_IMAGE_SERVICE` | (unset) | Same as `MIRABILIS_SKIP_IMAGE`. |
| `MIRABILIS_WAIT_IMAGE` | (unset) | `1` blocks startup until the image service is ready. Otherwise it starts in the background. |
| `IMAGE_SERVICE_STARTUP_TIMEOUT_MS` | `900000` | How long that wait lasts. |
| `IMAGE_SERVICE_URL` | `http://127.0.0.1:7860` | Image service endpoint used by the backend. |
| `MIRABILIS_IMAGE_TIMEOUT_MS` | `600000` | Per-request generation timeout. |
| `IMAGE_MODEL` | `sd-legacy/stable-diffusion-v1-5` | Hugging Face model the image service loads. |
| `IMAGE_SERVICE_PORT` | `7860` | Image service port. The launcher always sets 7860. |

## IntelLedger

| Variable | Default | What it does |
|---|---|---|
| `INTELLEDGER_REQUIRE_AUTH_CONTEXT` | `0` | `1` requires an authenticated tenant context on ledger routes. |
| `INTELLEDGER_RATE_LIMIT_STORE` | `memory` | `redis` shares limits across processes. |
| `INTELLEDGER_RATE_LIMIT_REDIS_URL` | (unset) | Redis URL when the store is `redis`. |
| `INTELLEDGER_MAX_TEXT_INGEST_CHARS` | `50000` | Cap on one text ingest. |
| `INTELLEDGER_MAX_SYNTHESIS_QUERY_CHARS` | `2000` | Cap on a synthesis query. |
| `INTELLEDGER_MAX_CROSS_SYNTH_SESSIONS` | `20` | Sessions per cross-session synthesis. |
| `INTELLEDGER_MEDIA_MAX_BYTES` | 150 MB | Largest media upload, minimum 5 MB. |
| `INTELLEDGER_MEDIA_MAX_DURATION_SEC` | `5400` | Longest media duration, minimum 60. |
| `INTELLEDGER_MEDIA_MAX_CONCURRENT` | `1` | Media jobs transcribing at once. |
| `INTELLEDGER_MEDIA_MAX_QUEUE` | `12` | Queue depth before new jobs are refused. |
| `INTELLEDGER_TRANSCRIBE_PROVIDER` | `auto` | `auto` uses the OpenAI API when `OPENAI_API_KEY` is set, else local. `openai` forces the API; any other value forces local (whisper.cpp, then the Python `whisper` CLI). |
| `INTELLEDGER_TRANSCRIBE_MODEL` | `whisper-1` | Model for the OpenAI transcription API. |
| `INTELLEDGER_WHISPER_CLI_MODEL` | `base` | Model for the Python `whisper` CLI. |
| `INTELLEDGER_REMINDER_WORKER_ENABLED` | `1` | `0` disables the reminder worker. |
| `INTELLEDGER_REMINDER_WORKER_INTERVAL_MS` | `60000` | Worker tick, minimum 10000. |
| `INTELLEDGER_REMINDER_WORKER_BATCH_SIZE` | `25` | Reminders per tick, 1 to 500. |
| `INTELLEDGER_REMINDER_MIN_INTERVAL_MS` | `900000` | Minimum gap between reminders for one item, minimum 60000. |
| `INTELLEDGER_REMINDER_WEBHOOK_URL` | (unset) | Where reminders are POSTed. |
| `INTELLEDGER_REMINDER_WEBHOOK_SECRET` | (unset) | Signs the webhook payload. |

## Desktop

| Variable | Default | What it does |
|---|---|---|
| `MIRABILIS_SIGNED` | (unset) | `1` lets macOS install updates itself. Only correct for a signed, notarized build. |

Update behavior and `update-settings.json` are in [DESKTOP.md](DESKTOP.md).

## Secrets

Keys set here are read by the backend process. Keys entered in the UI are stored
by the backend in `provider-keys.json` in the data directory, mode `0600`. The
browser never stores them and only sees a masked hint. This protects against
anything that can read a browser profile or run script in the page, not against
a process already running as you.

Agent run logs redact credential-shaped strings before writing. Connector
environment values and headers stay in `connectors.json` and never leave the
backend.

## File permissions

Data files are written `0600` and the data directory `0700`: chats, IntelLedger,
config vault index, homelab roster, personal memory, provider keys, Access
settings, the MCP server switch, connectors, model caches and agent run logs. Startup tightens existing files that are looser and logs how many it
changed. This is a file mode, not encryption; use whole-disk encryption
(FileVault, BitLocker, LUKS) for offline protection.

## Dependency overrides

CI runs `npm audit --omit=dev --audit-level=high` on the `backend`, `frontend`
and `desktop` lockfiles and fails on a high-severity production advisory.
Development trees are audited too but only reported.

| Package | Reason for override | Vulnerable copy was under |
|---|---|---|
| `qs` | express pins an old body-parser | express (backend) |
| `postcss` | the direct dependency is already newer | next |
| `postcss-selector-parser` | tailwind 3.x needs the 6.x API; 6.1.4 is patched | tailwind |
| `sharp` | next pins a version with open libvips CVEs | next (only used by `next/image`, which the app does not import) |
