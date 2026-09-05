# Configuration

Every setting is an environment variable. Mirabilis reads a `.env` file in
`backend/` at startup (via dotenv), so the usual way to set these is to copy
`.env.example` to `backend/.env` and edit it.

Nothing here is required. Mirabilis runs with no configuration at all: it binds
to loopback, stores data next to the repo, and talks to Ollama on its default
port. The variables exist for the cases where that is not what you want.

Defaults below are the real ones from `backend/src/config.js`, not suggestions.

## Server

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4000` | Backend HTTP port. |
| `MIRABILIS_BIND_HOST` | `127.0.0.1` | Interface to bind. **Leave this alone** unless you are putting an authenticating proxy in front: the API includes `/mcp` and `/api/remote/*`, which run shell commands. Binding to `0.0.0.0` exposes those to your network, and the app warns at startup when you do. |
| `FRONTEND_ORIGIN` | `http://localhost:3000` | Allowed browser origin for CORS. |
| `CORS_ALLOW_LOCALHOST` | `1` | Set `0` to refuse any localhost origin other than `FRONTEND_ORIGIN`. |
| `MIRABILIS_ALLOWED_HOSTS` | (loopback names) | Extra `Host` header values to accept, comma separated. Needed when serving through a named reverse proxy. Guards against DNS rebinding. |
| `TRUST_PROXY` | `loopback` | Passed to Express `trust proxy`. Only change this behind a real proxy. |
| `API_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window (minimum 10000). |
| `API_RATE_LIMIT_MAX` | `300` | Requests per window (minimum 50). |
| `NODE_ENV` | - | `production` withholds internal error detail from API responses. |

## Storage

| Variable | Default | What it does |
|---|---|---|
| `MIRABILIS_DATA_DIR` | `../mirabilis-data` beside the repo | Where chats, IntelLedger, the config vault, agent run logs and the MCP token live. |
| `DATA_DIR` | - | Older alias for the above. `MIRABILIS_DATA_DIR` wins. |

## Providers

| Variable | Default | What it does |
|---|---|---|
| `AI_PROVIDER` | `ollama` | Provider used when a request does not name one. |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama endpoint. |
| `OLLAMA_MODEL` | `llama3` | Fallback model when none is selected and none can be listed. |
| `OLLAMA_MODELS` | - | Ollama's own model directory, read when locating GGUF blobs. |
| `OPENAI_BASE_URL` | `http://127.0.0.1:8000/v1` | OpenAI-compatible endpoint. Despite the name this defaults to a LOCAL server. |
| `OPENAI_API_KEY` | (empty) | Key for OpenAI-compatible and cloud providers. |
| `OPENAI_MODEL` | `model.gguf` | Model for the OpenAI-compatible provider. |
| `KOBOLD_BASE_URL` | `http://127.0.0.1:5001/v1` | KoboldCpp endpoint. |
| `KOBOLD_MODEL` | `koboldcpp` | Label for the loaded KoboldCpp model. |
| `MIRABILIS_KOBOLDCPP_TAG` | - | Pin the KoboldCpp release used by the installer. |

## Web search

| Variable | Default | What it does |
|---|---|---|
| `TAVILY_API_KEY` | (empty) | Enables the `www` web-search chip. Without it, search is off. |
| `TAVILY_SEARCH_DEPTH` | `advanced` | `basic` or `advanced`. |

Web search is blocked entirely while Go Dark is on, regardless of this key.

## Local speech to text

| Variable | Default | What it does |
|---|---|---|
| `WHISPER_CPP_BINARY` | (auto-detected) | Path to `whisper-cli`, `whisper-cpp` or `main`. |
| `WHISPER_CPP_MODEL` | (auto-detected) | Path to a `ggml-*.bin` model. |

## Inference tuning

| Variable | Default | What it does |
|---|---|---|
| `MIRABILIS_MAX_HISTORY_TOKENS` | `8000` | Ceiling on history tokens per request. |
| `MIRABILIS_MAX_HISTORY_MESSAGES` | - | Ceiling on history message count. |
| `MIRABILIS_HISTORY_CTX_FRACTION` | `0.65` | Fraction of the context window history may occupy. |
| `MIRABILIS_THREADS` | (auto) | CPU threads for local inference. |
| `MIRABILIS_CONTRADICTION_MODEL` | - | Model for the contradiction detector. |

## Autonomous agent

| Variable | Default | What it does |
|---|---|---|
| `MIRABILIS_MCP_FS_ROOT` | (none: system-wide) | Confines agent and MCP file tools to one subtree. **Set this if you use the long tiers.** Note it bounds file tools and where a command starts, not what a shell command can reach. |
| `MIRABILIS_AGENT_FANOUT_CONCURRENCY` | `2` | Sub-agents generating at once. More is not faster against a single local engine (Ollama serialises per model) but does hold more live contexts. Raise only on hardware that serves requests in parallel. |
| `MIRABILIS_AGENT_MAX_CONCURRENT_RUNS` | `2` | Runs executing at once. Each carries its own budget and, at the full policy, its own shell, so this is a resource ceiling rather than a preference. |
| `MIRABILIS_MCP_TOKEN` | (generated) | Bearer token for `/mcp` and the privileged routes. Generated and persisted to the data directory when unset. |

## Image generation

| Variable | Default | What it does |
|---|---|---|
| `IMAGE_SERVICE_URL` | - | Endpoint of the Python image service. |
| `IMAGE_SERVICE_STARTUP_TIMEOUT_MS` | - | How long to wait for it to come up. |
| `MIRABILIS_IMAGE_TIMEOUT_MS` | - | Per-request image generation timeout. |
| `MIRABILIS_SKIP_IMAGE` | - | Skip starting the image service. |
| `MIRABILIS_WAIT_IMAGE` | - | Block startup until the image service is ready. |

## IntelLedger

| Variable | Default | What it does |
|---|---|---|
| `INTELLEDGER_REQUIRE_AUTH_CONTEXT` | - | Require an authenticated tenant context on ledger routes. |
| `INTELLEDGER_RATE_LIMIT_STORE` | (memory) | `redis` to share limits across processes. |
| `INTELLEDGER_RATE_LIMIT_REDIS_URL` | - | Redis URL when the store is `redis`. |
| `INTELLEDGER_MAX_TEXT_INGEST_CHARS` | - | Cap on a single text ingest. |
| `INTELLEDGER_MAX_SYNTHESIS_QUERY_CHARS` | - | Cap on a synthesis query. |
| `INTELLEDGER_MAX_CROSS_SYNTH_SESSIONS` | - | Sessions per cross-session synthesis. |
| `INTELLEDGER_MEDIA_MAX_BYTES` | - | Largest accepted media upload. |
| `INTELLEDGER_MEDIA_MAX_DURATION_SEC` | - | Longest accepted media duration. |
| `INTELLEDGER_MEDIA_MAX_CONCURRENT` | `1` | Media jobs transcribing at once. |
| `INTELLEDGER_MEDIA_MAX_QUEUE` | - | Queue depth before new jobs are refused. |
| `INTELLEDGER_TRANSCRIBE_PROVIDER` | `auto` | `auto`, `openai`, or local. |
| `INTELLEDGER_TRANSCRIBE_MODEL` | `whisper-1` | Model for the OpenAI transcription API. |
| `INTELLEDGER_WHISPER_CLI_MODEL` | `base` | Model for the Python `whisper` CLI fallback. |
| `INTELLEDGER_REMINDER_WORKER_ENABLED` | - | Enable the reminder worker. |
| `INTELLEDGER_REMINDER_WORKER_INTERVAL_MS` | `60000` | Worker tick. |
| `INTELLEDGER_REMINDER_WORKER_BATCH_SIZE` | `25` | Reminders per tick. |
| `INTELLEDGER_REMINDER_MIN_INTERVAL_MS` | `900000` | Minimum gap between reminders for one item. |
| `INTELLEDGER_REMINDER_WEBHOOK_URL` | - | Where reminders are POSTed. |
| `INTELLEDGER_REMINDER_WEBHOOK_SECRET` | - | Signs the webhook payload. |

## Development and diagnostics

| Variable | Default | What it does |
|---|---|---|
| `MIRABILIS_LOG` | - | Log file path used by `run.js`. |
| `MIRABILIS_VERBOSE` | - | Verbose launcher output. |
| `MIRABILIS_DEV_UI` | - | Run the frontend in dev mode from the launcher. |
| `NO_COLOR` | - | Disable coloured launcher output. |

## A note on secrets

API keys given here are read by the backend process.

Keys entered in the UI are also held by the backend, in `provider-keys.json` in
the data directory, written `0600`. They are never stored in the browser and
never sent from the page: the UI can set a key and see a masked hint of it, and
that is all. An install that predates this change has its keys moved out of
browser storage automatically the first time it runs.

Be clear about the limit. This is not protection from something already running
as you on this machine, which could read an OS keychain just as easily. What it
removes is the far wider set of things that can read a browser profile
directory or run script in the page.

Neither kind of key is written to an agent run's audit log: credential-shaped
strings are redacted before anything reaches disk.
