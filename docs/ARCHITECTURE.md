# How Mirabilis is built

A map of Mirabilis for anyone who wants to learn how it works, Mirabilis included: the
`mirabilis_architecture` tool hands this file to the model. Paths are relative to the source
root (the repo, or the `resources` folder of the packaged app). The code is the authority; this
file says where to look.

## At a glance

- Three local processes: a Next.js frontend (port 3000), an Express backend (port 4000) and a
  model engine (Ollama on 11434 by default). An optional Python image service listens on 7860.
- The backend binds to 127.0.0.1. The UI, in a browser tab or the desktop window, calls only the
  backend; the backend talks to engines, to a cloud provider when the user picks one, and to MCP
  connectors.
- A chat message streams back over Server-Sent Events and is saved to `chats.json` in the data folder.
- An agent run is a job with a work budget. It plans, calls tools, checks its result and stops when
  the budget says so. Access (Chat only, Read only, Ask first, Bypass) decides what tools may do.
- Connectors are MCP servers Mirabilis uses as a client. Mirabilis is also an MCP server at `/mcp`.
- Go Dark keeps the backend's own requests on this machine or the local network. Commands run in
  Bypass and local connectors are not filtered (see Go Dark).

## Processes and ports

| Process | Port | Started by | Code |
|---|---|---|---|
| Frontend, Next.js 15 | 3000 | `run.js` or the desktop app | `frontend/src` |
| Backend, Express | 4000 | `run.js` or the desktop app | `backend/src/server.js` |
| Ollama | 11434 | `run.js` starts it when it is not running | installed separately |
| Image service, Python | 7860 | `run.js`, in the background; `--no-image` skips it | `image-service/server.py` |
| llama-server, KoboldCpp | 8000, 5001 | `run.js --all-engines` or their own mode | `run.js` |
| llama.cpp launched from the app | 8080 | backend | `backend/src/llamacppRuntime.js` |
| Connectors | none (stdio) or a URL | backend: a local connector is its child process | `backend/src/mcp/connectors.js` |

`GET /health` on the backend answers `{ ok: true }`; both launchers poll it to know the backend is up.

## Source map

Backend (`backend/src`, Node ESM):
- `backend/src/server.js`: the app. Middleware, most routes, chat streaming, startup and shutdown.
- `backend/src/config.js`: port, bind host, data folder and provider defaults from the environment.
- `backend/src/modelService.js`: model lists and `streamWithProvider`, which calls
  `backend/src/providers/ollama.js`, `backend/src/providers/anthropic.js` (Claude) or
  `backend/src/providers/openaiCompatible.js` (OpenAI-style APIs: OpenAI, Gemini, Groq, vLLM and more).
- `backend/src/providerScope.js`: whether a provider sends data off the device. Go Dark uses it.
- `backend/src/egress.js`: Go Dark. `backend/src/security.js`: host guard, tokens, URL checks.
- `backend/src/agent/`: agent runs. Loop, budget, tools, Access, approvals, audit log.
- `backend/src/mcp/`: `mcpServer.js` (Mirabilis as a server) and the connector client.
- `backend/src/storage/`: JSON stores. `backend/src/routes/`: routers mounted by `server.js`.
- Features beside chat: `backend/src/recall.js` (search past chats with local embeddings),
  `backend/src/configVault.js` (cited answers over a folder of config files), IntelLedger
  (`backend/src/routes/intelLedger.js`, `backend/src/storage/intelLedger.js`), Homelab Roster
  (`backend/src/homelab.js`), watched workspace (`backend/src/workspace.js`), voice through
  whisper.cpp (`backend/src/services/whisperCpp.js`) and Piper, remote SSH control (in `server.js`).

Frontend (`frontend/src`, Next.js with React, rendered in the browser only):
- `frontend/src/app/page.js` loads `frontend/src/components/MirabilisAppLoader.jsx`, which loads
  `frontend/src/components/MirabilisApp.jsx`: the shell with the Chat and IntelLedger tabs.
- `frontend/src/components/ChatApp.jsx`: the chat view. Composer, provider and model menus,
  streaming, agent runs, approvals and the Settings sheet.
- `frontend/src/components/settings/`: the Settings sheet and its Access and Connectors panes.
- `frontend/src/components/shell/`: Dock, command palette, search, agent run strip, approval card.
- `frontend/src/lib/api.js`: `apiFetch`, which adds the session token from
  `frontend/src/lib/sessionToken.js`. `frontend/src/lib/sseParser.js` reads event streams.
- `frontend/src/store/useAppStore.js`: shared UI state (Settings open, Access level, Go Dark).

Elsewhere: `desktop/main.js` (Electron shell), `run.js` (launcher), `scripts/` (checks, version sync).

## A chat message, end to end

1. `ChatApp.jsx` posts `{ content, provider, model, ... }` to `/api/chats/:chatId/messages/stream`.
2. With Go Dark on, the route refuses a provider that would leave the device (403).
3. The user message is appended and the chat saved. On Ollama, model "Auto" lets
   `backend/src/modelRouter.js` pick an installed model for the task, and Uncensored mode picks an
   uncensored one.
4. The prompt is built: platform context, up to 20 personal memory items (not in Uncensored mode),
   the system prompt sent with the message, then a history window (`backend/src/historyWindow.js`)
   sized to the model's context. The window start is kept stable so the engine's prompt cache keeps
   hitting. Text attachments are inlined.
5. `streamWithProvider` streams tokens. The route sends SSE events `meta`, `token`, `notice`,
   `done` (the saved assistant message), `titleUpdate` and `error`.
6. The reply is saved. A new chat then gets a short title from the same model.

## Agent runs

`ChatApp.jsx` sends a message as an agent run when Access is not Chat only, or when the effort is
an agentic tier. The run is `POST /api/agent/runs` in `backend/src/agent/routes.js`; progress
streams back as SSE `progress` events, then `result`.

- Level: the lower of the level in the request and the saved one. A request can lower it, never
  raise it. Chat only with a single-shot effort is refused with `useChat: true`.
- Budget (`backend/src/agent/effortProfiles.js`, enforced in `backend/src/agent/budget.js`):
  Instant, Fast, Balanced and Thorough are single-shot; with tools on they run the small `assist`
  profile (10 minutes, 16 steps, 40 tool calls). High effort (30 minutes), 1 hour and 5 hours plan,
  validate and repair; the last two may fan out to sub-agents (`backend/src/agent/subAgents.js`).
- Loop (`backend/src/agent/agentLoop.js`): plan, then repeat: the model replies with one JSON
  action (`backend/src/agent/protocol.js`, built for small local models), the registry runs the
  tool, and the result (first 4000 characters) goes back into the next prompt. A finish is checked
  by a validation pass; a failed check triggers a repair. When the budget runs out, a wrap-up
  reports what was established.
- Tools (`backend/src/agent/tools.js`): `list_dir`, `read_file`, `search_files`, `write_file`,
  `edit_file`, `run_command`, plus the system tools (`backend/src/agent/systemTools.js`:
  `system_overview`, `list_processes`, `network_overview`, `read_log`), the self tools
  (`backend/src/agent/selfTools.js`: `mirabilis_status`, `mirabilis_logs`,
  `mirabilis_architecture`) and connector tools. Each has a kind: read, write, command, connector.
- Every call passes `decide()` in `backend/src/agent/permissions.js` first: allow, ask or deny.
- Ask: `backend/src/agent/approvals.js` emits `approval-required`; the approval card above the
  composer posts allow, always or deny to `/api/agent/runs/:id/approvals/:approvalId`. Waiting
  does not use up the budget (`pauseWhile`). A denial reaches the model as a tool error, with the
  user's note.
- Before a write, the old bytes are copied to `agent-runs/<runId>/before/` in the data folder.
- Record: each run appends JSON lines to `agent-runs/<runId>.jsonl` (`backend/src/agent/auditLog.js`,
  credentials redacted) and is indexed in `agent-runs/runs.json` (`backend/src/agent/runStore.js`).
  A run alive at shutdown is marked interrupted on the next start; runs are not resumed.

## Access levels

One setting, saved by the backend in `access.json` in the data folder and served at `/api/access`.

| Level | What a run may do |
|---|---|
| Chat only (default) | No tools at all. |
| Read only | Read files anywhere, inspect the system, run read-only commands, use read-only connector tools. Never changes anything and never asks. |
| Ask first | Everything Read only does, freely. Anything that changes something, or is not known to be read-only, pauses and asks. |
| Bypass | Everything, with no approvals, no command blocklist and no folder jail. |

- Read-only means proven read-only: `backend/src/agent/commandPolicy.js` splits a command on
  pipes and `&&`, `||`, `;`, refuses redirection and subshells, and checks every program and its
  arguments against a list (`ps`, `df`, `git status`, `brew services list`, and so on).
- "Always allow" in Ask first saves a rule such as `git status` to `allowCommands`. Rules apply in
  Ask first only; Read only stays strictly read-only.
- In Bypass the only things still applied are the operator jail `MIRABILIS_MCP_FS_ROOT` when set,
  the work budget, the audit log, and connector tools set to Off (not offered at all).
- The blocklist in `backend/src/agent/sandbox.js` (recursive `rm`, disk wipes, power off) applies in
  Read only and Ask first.

## Go Dark

- State lives in `go-dark.json`. `installEgressGuard()` wraps the global `fetch`, which then
  refuses any host that is not this machine or a private LAN address (`isLocalHostUrl`).
- Chat and agent routes refuse cloud providers up front with a plain 403.
- Remote HTTP connectors stop with "Blocked by Go Dark". Local (stdio) connectors keep running,
  and their own network use is up to them.
- With Go Dark on, a command that uses the network (`ping`, `curl`, `git fetch`) is denied in
  Read only and asked about in Ask first, with no "always" offered. In Bypass commands are not
  filtered.
- The desktop updater makes no request until the UI reports Go Dark is off.

## Connectors (MCP client)

- Store: `connectors.json` in the data folder, written atomically with a `.bak`. Old
  `mcp-servers.json` entries are imported once.
- Manager: `backend/src/mcp/connectors.js`. It starts enabled connectors in the background at
  boot, restarts a crashed one at most 3 times in 5 minutes, keeps the last 300 stderr lines, and
  stops each one with its whole process group.
- Transports: `backend/src/mcp/stdioClient.js` (JSON-RPC over stdin and stdout, PATH widened with
  Homebrew and user tool folders) and `backend/src/mcp/httpClient.js` (streamable HTTP with a
  session id).
- Catalog: `backend/src/mcp/catalog.js` lists ready-made servers (filesystem, memory, git, fetch,
  time, Junos and more) and whether `npx`, `uvx` or `python3` is installed.
- Each tool has a permission: Allow, Ask or Off. A tool marked read-only by its server starts at
  Allow, the rest at Ask. Agents see a tool as `<connector>__<tool>`.
- Routes: `backend/src/routes/connectors.js` at `/api/connectors`. The Settings pane is
  `frontend/src/components/settings/ConnectorsPane.jsx`.

## Mirabilis as an MCP server

`POST /mcp` (`backend/src/mcp/mcpServer.js`) offers `mirabilis_chat`, `mirabilis_list_models`,
`mirabilis_health`, `system_info`, `list_dir`, `read_file`, `write_file` and `run_command` to any
MCP client. It needs the bearer token stored in `mcp-token` in the data folder.

## Who may call the backend

- It binds to 127.0.0.1 (`MIRABILIS_BIND_HOST` changes that). A host guard rejects foreign `Host`
  headers (DNS rebinding) and CORS allows only the configured frontend origin and loopback origins.
- One token per install, in `mcp-token`, guards `/mcp` and the privileged routes: agent runs,
  Access, connectors, provider keys, remote SSH, the watched workspace and the Config Vault.
- The UI gets that token from `GET /api/session/token`, which answers only local callers with an
  allowed Origin.
- Provider API keys stay in the backend (`provider-keys.json`); the UI sees a masked hint.
- Data files are written owner-only (0600 files, 0700 folders, `backend/src/storage/securePaths.js`).

## The data folder

`MIRABILIS_DATA_DIR` or `DATA_DIR`, else `../mirabilis-data` next to the repo. The desktop app
sets it to Electron's user data folder (on macOS `~/Library/Application Support/Mirabilis AI`).

| File | Holds |
|---|---|
| `chats.json` (+ `.bak`) | Every saved chat. Off-the-Record chats live in memory only. |
| `access.json` | Access level and always-allowed commands. |
| `connectors.json` | Connectors and per-tool permissions. |
| `go-dark.json` | Go Dark on or off. |
| `provider-keys.json` | Cloud provider API keys. |
| `mcp-token` | The local session and MCP token. |
| `personal-memory.json` | Personal memory items. |
| `intelledger.json`, `config-vault.json`, `homelab-hosts.json` | Feature stores. |
| `agent-runs/` | Run logs (`<runId>.jsonl`), `runs.json`, and pre-write copies. |
| `images/`, `uploads/` | Generated images and chat attachments. |
| `fine-tuning-examples.jsonl` | Examples saved when Training is set to fine-tuning. |

`mirabilis_status` lists these files by name and size, never their contents.

## The desktop app

`desktop/main.js` (Electron):
- Takes a single-instance lock, then frees ports 3000 and 4000 from a stale Mirabilis process only.
- Starts the backend from `resources/backend` with Electron's own Node (`ELECTRON_RUN_AS_NODE`) and
  `DATA_DIR` set to the user data folder, and the frontend from the Next.js standalone build on
  127.0.0.1:3000.
- Writes their output to `backend.log` and `frontend.log` in Electron's logs folder
  (`~/Library/Logs/Mirabilis AI` on macOS).
- Opens one window on http://localhost:3000. Links to other sites open in the system browser.
  Closing the window hides it to the tray.
- Updates come from GitHub releases through `desktop/updater.js`.

Packaging: `desktop/build.sh` (macOS, Linux) and `desktop/build.bat` (Windows) stage the backend,
the standalone frontend and `docs/`, and electron-builder copies them into `resources`. That folder
is the source root of a packaged app, so the self tools find this file and the backend source there.

## The launcher: run.js

`node run.js` installs what is missing, builds the frontend when its source changed, makes sure
Ollama runs with a model, starts the backend, the frontend and the image service, and waits.
Modes: `dev` (hot reload), `doctor`, `logs`, `stop`, `restart`, `install`, `uninstall`.
Logs go to `backend.log`, `frontend.log` and `image-service.log` in the system temp folder.

## Where to look when something is wrong

- Reply failed or slow: `mirabilis_logs` (backend), then `system_overview` for memory pressure and
  CPU, and `mirabilis_status` for Ollama and the installed models.
- A connector fails: its status and stderr lines in Settings, Connectors, or `GET /api/connectors/:id/logs`.
- What did a run do: `agent-runs/<runId>.jsonl` in the data folder.
- How a feature works: find its route in `backend/src/server.js` or `backend/src/routes/`, then read
  the module it calls.
