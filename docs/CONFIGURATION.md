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
| `MIRABILIS_DATA_DIR` | `../mirabilis-data` beside the repo | Chats, IntelLedger, config vault, agent run logs, MCP token. |
| `DATA_DIR` | (unset) | Older alias. `MIRABILIS_DATA_DIR` wins. The desktop app sets it to its per-app data folder. |

## Providers

| Variable | Default | What it does |
|---|---|---|
| `AI_PROVIDER` | `ollama` | Provider used when a request does not name one. |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama endpoint. |
| `OLLAMA_MODEL` | `llama3` | Fallback model when none is selected and none can be listed. |
| `OLLAMA_MODELS` | `~/.ollama/models` | Ollama's model directory, read to locate GGUF blobs for llama.cpp. |
| `OPENAI_BASE_URL` | `http://127.0.0.1:8000/v1` | OpenAI-compatible endpoint. Defaults to a local server. |
| `OPENAI_API_KEY` | (empty) | Fallback key for OpenAI and OpenAI-compatible providers when none is set in the UI. Also used for OpenAI transcription. |
| `OPENAI_MODEL` | `model.gguf` | Model for the OpenAI-compatible provider. |
| `KOBOLD_BASE_URL` | `http://127.0.0.1:5001/v1` | KoboldCpp endpoint. |
| `KOBOLD_MODEL` | `koboldcpp` | Label for the loaded KoboldCpp model. |
| `MIRABILIS_CATALOG_URL` | `backend/models.json` on the repo's main branch | Remote suggested-model catalog, fetched at most hourly. |
| `MIRABILIS_USER_CATALOG` | `~/.mirabilis/models.json` | Your own catalog additions; wins over bundled and remote. |

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

## Autonomous agent

| Variable | Default | What it does |
|---|---|---|
| `MIRABILIS_MCP_FS_ROOT` | (unset, no jail) | Confines agent and MCP file tools, and the command working directory, to one subtree. Set it before using the long tiers. It does not limit what a running shell command can reach. |
| `MIRABILIS_AGENT_FANOUT_CONCURRENCY` | `2` | Sub-agents generating at once, maximum 8. A single local engine serves one request per model at a time, so more only holds more live contexts. Raise it for an engine that serves in parallel. |
| `MIRABILIS_AGENT_MAX_CONCURRENT_RUNS` | `2` | Runs executing at once. Each has its own budget and, under `full`, its own shell. |
| `MIRABILIS_MCP_TOKEN` | generated | Bearer token for `/mcp` and the privileged routes. Generated and saved to the data directory when unset. |

### Tiers

| Tier | Wall clock | Steps | Tool calls | Sub-agents |
|---|---|---|---|---|
| High effort | 30 min | 12 | 60 | none |
| 1 hour | 60 min | 80 | 500 | up to 3 |
| 5 hours | 5 hours | 400 | 2500 | up to 6 |

The budget is enforced in code. A run that hits it returns what it has plus a
note on what is left undone. Runs are held in memory, so a backend restart drops
one in flight. Small models struggle with the tool-calling format; 12B or larger
works better.

### Tool policies

| Policy | Tools | Reach |
|---|---|---|
| `read-only` (default) | `list_dir`, `read_file`, `search_files` | reads inside the file root |
| `write` | adds `write_file` | writes inside the file root |
| `full` | adds `run_command` | a real shell |

`full` gives the model the same reach as the account running Mirabilis. It must
be acknowledged per run and is never the default. The mitigations:

- A pattern blocklist rejects recursive `rm`, `mkfs`, `dd` to a device, fork
  bombs, `shutdown` and recursive `chmod` on `/`. It catches accidents, not a
  determined prompt.
- `MIRABILIS_MCP_FS_ROOT` sets where a command starts, not where it can go.
- Every tool call goes to an append-only audit log.

Real confinement needs an OS sandbox (container, VM, Seatbelt, namespaces).
For most work use `write` with a file root.

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

Agent audit logs redact credential-shaped strings before writing.

## File permissions

Data files are written `0600` and the data directory `0700`: chats, IntelLedger,
config vault index, homelab roster, personal memory, provider keys and agent run
logs. Startup tightens existing files that are looser and logs how many it
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
