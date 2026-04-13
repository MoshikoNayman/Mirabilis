# Mirabilis AI — Changelog

Versioning follows Junos-style tags.

## [26.3R1-S15] — 2026-04-12

### Installer Prerequisite Guard

- Added fail-fast Ollama prerequisite check to `install.sh`.
- Installer now exits with a clear actionable message if Ollama is missing, instead of printing "installation complete" and failing later at `./run.sh ui`.
- Added platform-specific guidance (`brew install ollama` on macOS, download link otherwise).

---

## [26.3R1-S14] — 2026-04-12

### Chat Performance Optimization

- Reduced server-injected platform system prompt size to cut prefill overhead.
- Added bounded conversation history window for inference context:
  - `MIRABILIS_MAX_HISTORY_MESSAGES` (default: 24)
  - `MIRABILIS_MAX_HISTORY_TOKENS` (default: 1800)
- Result: tiny-message baseline prompt estimate dropped significantly (observed ~725 -> ~217 tokens), reducing CPU spikes and response startup latency.

---

## [26.3R1-S13] — 2026-04-12

### JS Command Surface Expansion (Pre-Cutover)

- Added `install` and `uninstall` subcommands to `run.js`.
- These commands delegate to existing `install.sh` / `uninstall.sh` scripts to keep pre-cutover compatibility and rollback safety.
- Updated launcher help and unknown-mode guidance to include lifecycle commands.
- No cutover performed: shell scripts remain canonical compatibility entrypoints.

---

## [26.3R1-S12] — 2026-04-12

### Pre-Cutover Governance (Docs)

- Added explicit JS launcher pre-cutover requirements to README (functional parity, reliability, install/cancel/retry, fallback behavior).
- Added a concise pre-cutover verification command set.
- Added cutover rollback playbook with fork/tag/branch strategy and wrapper retention guidance.
- No runtime code changes in this revision.

---

## [26.3R1-S11] — 2026-04-12

### Model Install Job System

- Added persistent server-side model install jobs with APIs:
  - `POST /api/models/install-jobs` (start)
  - `GET /api/models/install-jobs/:jobId` (status)
  - `POST /api/models/install-jobs/:jobId/cancel` (cancel)
  - `GET /api/models/install-jobs` (recent jobs)
- Frontend model install flow now uses job polling instead of a single fragile streaming request.
- Cancel in UI now triggers backend cancel request and attempts to terminate active install work.
- Install progress/status now survives frontend refresh/reload because job state is kept server-side.

---

## [26.3R1-S10] — 2026-04-12

### MSQ GUI Install Fixes

- Fixed GUI model install flow for MSQ models (`msq-pro-12b`, `msq-ultra-31b`, `msq-raw-8b`).
- `POST /api/models/pull` now detects `msq-*` IDs and builds from local Modelfiles instead of trying registry-only pull behavior.
- Added automatic base-model pull for MSQ installs when missing.
- Added clearer streamed progress/status messages for MSQ build steps.
- Improved frontend install error handling so failures are shown in status text instead of silently disappearing.

---

## [26.3R1-S9] — 2026-04-12

### MSQ Model Setup Reliability

- Hardened `training/msq/setup.sh` for easier recovery when MSQ models fail to install.
- Added preflight checks for Ollama CLI presence and daemon availability.
- Added automatic base-model pull before each `ollama create` step.
- Added lighter install mode: `--skip-ultra` / `--lite` (or `MSQ_SKIP_ULTRA=1`) to skip the large Ultra model.
- Improved error messages with actionable guidance for pull/create failures.

---

## [26.3R1-S8] — 2026-04-12

### JS Launcher Enhancements

- Added `doctor` command to `run.js` / `run.sh` wrapper for quick environment and endpoint validation.
- Added `restart [provider]` command for one-shot stop/start cycles.
- Added deterministic stop behavior using PID state file (`mirabilis-run-state.json`) instead of relying only on broad process pattern matching.
- Kept fallback behavior: if no PID state is found, launcher still uses legacy pattern-based stop.
- Added startup readiness supervision for backend (`/health`), frontend (`/`), and image service (`/health`) with explicit timeouts and clear errors.
- Maintained safe-mode architecture: `run.js` is source of truth; `run.sh` remains a thin compatibility wrapper.

---

## [26.3R1-S7] — 2026-04-12

### Launcher Bug Fixes

- Fixed `run.js` model download path: converted Fetch WebStream to Node stream (`Readable.fromWeb`) before writing to file.
- Removed hard 120-second fetch timeout for GGUF download to avoid false failures on slower links.
- Fixed provider fallback reliability: model preparation failures now return cleanly so `openai-compatible` and `koboldcpp` can fall back to Ollama instead of crashing launcher startup.
- Improved command detection on Unix by using `sh -c "command -v ..."` for more reliable executable checks.
- Added cross-platform npm invocation helper (`npm` vs `npm.cmd`) to avoid Windows spawn issues.

---

## [26.3R1-S6] — 2026-04-12

### Launcher Architecture

- Added `run.js` as a new Node.js launcher with the same modes as `run.sh` (`ui`, `ollama`, `openai-compatible`, `koboldcpp`, `stop`, `--log`).
- Kept `run.sh` as safe fallback mode: it now delegates to `run.js` and preserves existing command habits.
- Added cross-platform launcher behavior in `run.js` for process orchestration, logs, provider startup, and stop flow.
- Kept existing UX intact (`./run.sh` still works) while enabling direct testing via `node run.js`.

---

## [26.3R1-S5] — 2026-04-12

### System Control Tools (MCP)

- Added five new MCP tools to control the machine where Mirabilis is installed:
  - `system_info` — returns OS, platform, arch, hostname, home dir, cwd, Node version. No confirmation needed.
  - `list_dir` — lists files/directories at any path. No confirmation needed.
  - `read_file` — reads text file contents up to 512 KB. No confirmation needed.
  - `write_file` — writes or overwrites a file. Requires `confirmed: true` in arguments.
  - `run_command` — executes a shell command (macOS, Linux, Windows). Requires `confirmed: true` in arguments.
- Read-only tools never prompt for approval. Write/exec tools require the AI to explicitly pass `confirmed: true`, which VS Code surfaces to the user before calling.
- Command safety blocklist rejects catastrophic patterns: `rm -rf /`, `mkfs`, `dd if=`, `format C:`, fork bombs, `shutdown`/`reboot`.
- `run_command` returns stdout + stderr + exit code even on non-zero exit, so errors are readable.
- Cross-platform path resolution using `node:path.resolve` — works on macOS, Linux, and Windows.
- Bumped server version to `26.3R1-S5`.

---

## [26.3R1-S4] — 2026-04-12

### MCP Server

- Mirabilis now exposes itself as an MCP server at `POST http://127.0.0.1:4000/mcp` (streamable-http transport).
- Three tools available to any MCP client (VS Code, GitHub Copilot, Claude Desktop, etc.):
  - `mirabilis_chat` — send a prompt, get an AI response; provider and model are selectable per call.
  - `mirabilis_list_models` — list available models for a given provider.
  - `mirabilis_health` — check readiness of all configured providers.
- Session management with UUID session IDs per client connection.
- Implementation: `backend/src/mcp/mcpServer.js`; mounted in `server.js` at start.

### Provider Adapter Modules

- Added missing `backend/src/providers/ollama.js` — Ollama model discovery and streaming chat.
- Added missing `backend/src/providers/openaiCompatible.js` — OpenAI-compatible API streaming and model listing (`listOpenAICompatibleModels` + `streamOpenAICompatibleChat`).
- Both modules were previously absent, causing backend startup failure.

### Logging Flag

- All logging is **off by default** — no files written, no console noise.
- New `--log` flag for `run.sh` enables:
  - Live `[MCP-SERVER]` output in terminal for every session and tool call.
  - `backend/data/mcp-server-audit.jsonl` audit file (JSONL, one event per line).
- Flag works in any position: `./run.sh --log`, `./run.sh ollama --log`.
- `MIRABILIS_LOG` env var drives the same behavior for direct node invocations.

### run.sh — Backend Output

- Backend output is silent by default (`> /tmp/backend.log 2>&1`).
- With `--log`: backend pipes through `tee` so output appears in terminal and is saved to log simultaneously.

---

## [26.3R1-S3] — 2026-04-10

### MSQ Model Family

- **MSQ-Pro-12B** — deep-reasoning workhorse tuned on `gemma3:12b` (12B, 8.1 GB), 32 768-token context.
- **MSQ-Ultra-31B** — flagship model tuned on `gemma4:31b` (~20 GB), 65 536-token context; most capable model in the family.
- **MSQ-Raw-8B** — fully unrestricted variant tuned on `dolphin3` / Llama 3.1 (8B, 4.9 GB), 8 192-token context; `uncensored: true` flag enables bypass of all safety system prompts.
- Removed MSQ-Lite-4B from the lineup; MSQ-Pro-12B is the new entry point.
- `training/msq/` directory — contains `Modelfile.msq-pro-12b`, `Modelfile.msq-ultra-31b`, `Modelfile.msq-raw-8b`, and `setup.sh` (`bash training/msq/setup.sh` creates all three models via `ollama create`).
- MSQ group registered at the top of `CURATED_OLLAMA_MODELS` in `modelService.js` so models appear first in the model selector.

### Uncensored Mode Hardening

- `UNCENSORED_DIRECTIVE` is now `unshift`-ed to array position 0 in the system-prompt chain, overriding any earlier instructions.
- Platform-context confidentiality rules 3–5 are excluded when `chatUncensoredMode` is `true`, preventing them from silently suppressing the uncensored directive.
- `isUncensoredModelRecord` pattern in `server.js` extended to match the `msq-raw` model ID.

### Web Search (www Chip)

- Replaced the dead DuckDuckGo instant-answer endpoint with a direct RSS-feed parser.  Sources: Fox News, BBC, CNN, Reuters, AP, New York Times, The Guardian, TechCrunch, The Verge.
- Web search capability description added to platform context so the model can reference fetched results in its response.
- `webSearchStatus` now has an `'error'` state (red chip shown for 4 s on failure) in addition to `'idle'` and `'searching'`.
- `classifyWebSearch` default changed from `'skip'` to `'search'`; skip is now reserved for pure write/code-only verbs.

### Inline Code Rendering Fix

- `react-markdown` v10 dropped the `inline` boolean prop from the `code` component. Detection now uses absence of a `language-*` class and no newlines in the string instead.
- `canRun` guard in `ChatApp.jsx` updated to use `isInline` (was the now-undefined `inline` prop, which caused all backtick spans to render as full block elements).
- Inline code spans now use `var(--accent-soft)` background, `var(--accent)` border, and `var(--accent)` text colour so they follow the active palette.

### Bug Fix — Clear-All Chat Resurrection

- `getEpoch()` added to `chatStore.js` and imported in `server.js`.
- `server.js` title-generation (`titleGenPromise`) now snapshots `requestEpoch` at request time and aborts the deferred `saveChat` write if `clearChats` ran in the interim, preventing cleared chats from being recreated.

### Chip / Toolbar Polish

- All left-side toolbar chips (`compute`, `npu`, `www`, `Instructions`) now use identical structure: text label only, no decorative dot.

### UI Polish & Styling Session

- **4-scheme palette system** — Mirabilis (green), Dusk (indigo/violet), Ember (warm amber), Summit (Apple blue). Replaces hardcoded accent values with CSS custom properties; Tailwind `accent`/`accentSoft` tokens now resolve from CSS vars, so all components update automatically on scheme switch.
- **Palette picker** — 4-button pill grid in the Appearance panel; no-flash restore via inline script in `layout.js`.
- **Syntax highlighting** — `react-syntax-highlighter` (Prism) with a per-scheme 13-var token theme covering comment, keyword, tag, attr, string, number, fn, and lang tokens. Line numbers included.
- **Streaming phase labels** — typing indicator cycles through Processing → Thinking → Generating → Loading model → Still working… phases during long inference.
- **Role labels** — "user" → "You", "assistant" → "AI".
- **Auto-scroll overhaul** — programmatic vs. user scroll guard via `isProgrammaticScrollRef`; ref checked inside `requestAnimationFrame` (not just at effect entry) to close the RAF-queue race. `lastScrollTopRef` synced after every programmatic scroll so direction detection stays accurate.
- **"New messages ↓" pill** — centered at bottom of chat, themed to current palette accent color.
- **Dusk replaces Flower** — Flower (teal) was too close in hue to Mirabilis (green). Dusk uses deep indigo (`#5046e4`) with a deep-space code block. LocalStorage validation updated; old `flower` value gracefully falls back to Mirabilis.
- **Bug fix** — duplicate stray `</button>` JSX in palette picker (caused by a prior edit) removed.
- **Bug fix** — `layout.js` pre-hydration scheme script now validates against whitelist before setting attribute, preventing flash if an obsolete scheme name is in localStorage.

## [26.3R1] — 2026-04-08

### Chat Sidebar Enhancements

- **Chat search** — live filter input above the chat list; always visible, scrolls with header not with list.
- **Chat rename** — inline rename input in each chat item's three-dot menu.
- **Chat export** — download any conversation as a Markdown `.md` file from the three-dot menu.
- **Pin / unpin chats** — star icon in the three-dot menu pins chats to the top of the list; persisted in `localStorage`.
- **Sorted chat list** — pinned chats always appear above unpinned ones.
- Keyboard shortcut **Ctrl+K / ⌘K** creates a new chat from anywhere.
- Creating a new chat clears any active search query so the new chat is immediately visible.
- Chat three-dot menus now close on outside click or Escape.

### Generation Parameters Panel

- **Temperature slider** (0–2.0) and **Max tokens** number input added to the model dropdown.
- Settings persist across sessions via `localStorage`.
- Both parameters are sent end-to-end through the stream request to all providers:
  - Ollama: `options.temperature` + `options.num_predict`
  - OpenAI-compatible / KoboldCpp: `temperature` + `max_tokens`
- Resetting temperature to default (null) removes the field from the request, letting the provider use its own default.

### Backend Reliability

- **Write-lock serialisation** in `chatStore.js` — all write operations are queued through a promise mutex, eliminating concurrent read-modify-write data loss under fast streaming.
- **Read cache** in `chatStore.js` — invalidated on every write; eliminates redundant filesystem reads within the same request cycle.
- **Epoch guard** — `saveChat` snapshots the store epoch before entering the queue; if `clearChats` ran while the save was waiting, the write is silently dropped, preventing cleared chats from being resurrected.
- **Message rollback** — if an assistant stream produces no output (provider not running), the user message is removed from the chat and `updatedAt` is restored, keeping the store clean.
- **Chat rename API** — `PATCH /api/chats/:chatId` now accepts `{ title }` to rename a chat (truncated to 80 chars).

### Toolbar Chip Re-order & OpenClaw Redesign

- Toolbar chip order now ends with **Control → MCP → OpenClaw** for logical grouping.
- Removed the standalone "i" info button next to OpenClaw.
- OpenClaw chip now shows a **CSS hover tooltip** describing the profile — no click, no state, no extra button.

### Send Button

- Send button height reduced so it no longer touches the Voice chip; both elements remain aligned with the textarea height.

### Removed

- Deleted the ICQ theme (`ICQApp.jsx` and the `/icq` route) — no longer part of the product.

---

## [26.2R1] — 2026-04-06

### Launcher and Naming Cleanup

- Replaced fragmented startup scripts with a unified launcher:
  - `install.sh`
  - `run.sh`
- Added canonical provider names across launcher, backend, and UI:
  - `ollama`
  - `openai-compatible`
  - `koboldcpp`
- Removed legacy alias behavior from `run.sh` so provider naming is consistent.

### Provider Runtime Reliability

- `install.sh` now installs and validates local runtime binaries:
  - `llama-server`
  - `koboldcpp`
- KoboldCpp installer now fetches the latest release asset from GitHub and validates binary format.
- `run.sh` now supports explicit provider modes:
  - `./run.sh ollama`
  - `./run.sh openai-compatible`
  - `./run.sh koboldcpp`
- `./run.sh` (UI mode) starts all available local providers so switching in UI does not require relaunching.

### CPU Core Utilization

- Added automatic thread detection using all logical CPU cores by default for:
  - `llama-server`
  - `koboldcpp`
- Added override env var:
  - `MIRABILIS_THREADS=<n>`
- Applied thread flags:
  - `llama-server`: `--threads`, `--threads-batch`, `--threads-http`
  - `koboldcpp`: `--threads`, `--blasthreads`

### Session Management

- Added `./run.sh stop` to cleanly terminate all Mirabilis/provider processes.

### Uncensored Mode Hardening

- Backend uncensored directive tightened to reduce refusals/moralizing on profanity-heavy prompts.
- Added guard to avoid policy/instruction leakage in uncensored responses.

### Config and Provider Defaults

- OpenAI-compatible default base URL updated to `http://127.0.0.1:8000/v1`.
- Provider-health fallback behavior improved so unreachable external providers can fall back to Ollama when available.

### Docs Refresh

- README rewritten to match current scripts and canonical provider modes.
- Removed stale references to deleted scripts (`run-local.sh`, `mirabilis-start.sh`, etc.).


