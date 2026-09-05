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

### Tool policies, and what `full` really means

The agent runs under one of three policies.

| Policy | Tools | What it can touch |
| --- | --- | --- |
| `read-only` | `list_dir`, `read_file`, `search_files` | reads inside the file root, nothing else |
| `write` | adds `write_file` | writes inside the file root |
| `full` | adds `run_command` | a real shell |

`full` is a real shell, and that is an accepted risk rather than a solved
problem. Be clear about what the mitigations do and do not do:

- A blocklist rejects the recognisable destroyers: recursive `rm`, `mkfs`,
  `dd` to a device, fork bombs, `shutdown`, recursive `chmod` on `/`. It
  matches patterns, so it stops accidents and obvious damage. It is not a
  sandbox and a determined prompt can express the same intent another way.
- `MIRABILIS_MCP_FS_ROOT` confines the file tools and sets where a command
  starts. It does not confine where a command can go once running.
- The `full` policy has to be acknowledged explicitly per run. It is never
  the default and cannot be reached by accident.
- Every tool call is written to an append-only audit log, so what ran is
  recoverable afterwards.

The honest summary: `full` gives a model the same reach as the account running
Mirabilis. Treat granting it as you would treat pasting a script from the
internet into a terminal. If that is not acceptable for a given task, use
`write`, which covers most real work, and set a file root.

Actually confining it would mean an OS-level sandbox: a container, a VM, or
Seatbelt and namespaces. That is a different feature, not a patch to this one,
and pretending the blocklist is equivalent would be the more dangerous choice.

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

## File permissions

Everything in the data directory is written `0600` and the directory itself is
`0700`, so it is readable only by the account running Mirabilis. That covers the
chat history, IntelLedger, the indexed config vault, the homelab roster,
personal memory, provider keys and agent run logs.

These stores were previously created with the process umask, which is normally
`022`, so they landed world-readable. An install that predates this is corrected
at startup and logs how many files it tightened.

This is a file mode, not encryption. It closes the other-local-user and
stray-copy cases. It does not protect against someone who can read the disk
offline, or against a process already running as you. For the first, use
whole-disk encryption (FileVault, BitLocker, LUKS), which is the right tool and
already exists on every platform this app ships to.

## Updates

The desktop app can check for new releases and install them. Three things
constrain how that works, and all three are deliberate.

**Go Dark stops update checks.** The check runs in the Electron main process,
which sits outside both the renderer and the backend send path where Go Dark is
normally enforced. So the main process is told the lockdown state over IPC and
refuses to check until it has been told the lockdown is off. Not knowing counts
as locked down: on a launch where the renderer has not reported yet, no check
happens. Go Dark means nothing leaves the machine, and that has to include the
updater.

**Nothing downloads without being asked.** `autoDownload` is off. The app tells
you a version is available and you choose Download, Skip This Version, or Later.
Skipping records the version, not a flag, so skipping 26.3.2 does not also
silence 26.4.0.

**macOS cannot self install until the app is signed.** Squirrel.Mac validates
the code signature of the running bundle before swapping it, and an unsigned
build fails that check. Rather than offer a download that breaks at the last
step, an unsigned macOS build says so and opens the releases page. Windows and
Linux self install today. When signing and notarization are in place, build with
`MIRABILIS_SIGNED=1` and macOS behaves like the others.

Checks are rate limited to once every six hours. A manual check from the menu
(macOS) or the tray (Windows and Linux) ignores that limit and always reports
something, including when it declines to check and why.

| Setting | Where | Default |
| --- | --- | --- |
| `enabled` | `update-settings.json` in the app data directory | on |
| `skippedVersion` | same file, written when you choose Skip | none |
| `lastCheckAt` | same file | none |

That file is 0600 like everything else the app writes.

### Releases

`build.publish` in `desktop/package.json` points electron-builder at the GitHub
releases of this repository, which is also what makes it emit the `latest*.yml`
feed files. Those files are what an installed app reads; a release without them
reports "no update" forever, which is indistinguishable from being up to date.
The release workflow fails if they are missing rather than shipping that.

macOS builds produce both a `.dmg` and a `.zip`. The dmg is for installing by
hand; the zip is the only thing Squirrel.Mac can install an update from.

## Dependency advisories

CI audits the lockfiles on every push. The gate is on what ships: the
production trees of `backend`, `frontend` and `desktop` fail the build at high
severity. Development trees are reported but do not block, because they are
build and test tooling that never reaches a user and is frequently only fixable
by a major bump of the toolchain itself.

All three production trees are currently clean. Getting there needed three
`overrides` entries, which are worth explaining because they look like
duplication:

| Package | Why an override | Where the vulnerable copy lived |
| --- | --- | --- |
| `qs` | express pins an old body-parser | nested under express |
| `postcss` | the direct dependency was already newer | nested under next |
| `postcss-selector-parser` | tailwind 3.x needs the 6.x API, and 6.1.4 is patched | tailwind |
| `sharp` | next pins a version with open libvips CVEs | nested under next |

`sharp` is only used by next's image optimizer, and this app imports
`next/image` in exactly zero files, so it is dead weight that was carrying four
high-severity CVEs. The override is the cheap fix; removing it entirely is
possible if next ever makes that straightforward.

### What the audit does not cover

`npm audit` says nothing about the Electron runtime that electron-builder
bundles into the installer. That runtime is a full Chromium, and it is the
largest piece of third-party code that reaches a user's machine. Its version is
tracked as its own concern, not by the dependency gate.

### The Electron runtime

The installer bundles a full Chromium. It is the largest piece of third-party
code that reaches a user's machine, and `npm audit` cannot see it, so its
version is tracked deliberately rather than by the dependency gate.

The app ships Electron 44 (Chromium 152, Node 24). Electron supports roughly the
three most recent majors, so falling more than that behind means shipping a
browser engine with published, unpatched CVEs regardless of how clean the
lockfiles look.

**electron-builder is pinned to 25.1.8, and that pin is load bearing.** Version
26 stopped copying `node_modules` out of `extraResources`. This app ships its
backend that way and runs it as a separate Node process, so under 26 the build
succeeds, the installer is valid, the window opens, and the backend dies on its
first import with `Cannot find package 'express'`. Nothing in the pipeline
noticed, because every check looked at the installer rather than at whether the
app worked.

`verify-release.js` now fails the build when the packaged backend has no
dependencies, so the same mistake reports itself at build time. If you upgrade
electron-builder, that check is what will tell you whether the upgrade is safe.
The advisories against electron-builder 25 are in the build toolchain, which
never runs on a user's machine, and the audit gate reports them without
blocking.
