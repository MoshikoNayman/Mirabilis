# Changelog

Versions use Junos-style tags. Newest first.

## [26.4R1-S1] - 2026-11-11

- Autonomous runs (High effort, 1 hour, 5 hours): plan, act, validate, repair
  under a hard budget enforced in code. Answer styles stay single-shot.
- Out of budget returns the work so far; failed validation is reported as such.
- Access levels in the composer: Chat only (default), Read only, Ask first,
  Bypass. Saved in `access.json`; replaces the `write` and `full` tool policies.
- Ask first pauses the run on an approval card: allow once, allow file changes
  for the run, always allow a command, or deny with a note.
- Bypass runs any command or edit with no prompt and no blocklist.
- A shell parser decides which commands are read-only: pipes, redirects,
  substitution, and write flags such as `sort -o`, `rg --pre` and `git -c`.
- Troubleshooting tools: system overview, processes, listening ports, logs.
  Mirabilis reads its own source and `docs/ARCHITECTURE.md` to explain itself.
- `edit_file`; every file is copied to `agent-runs/<id>/before/` before it changes.
- Connectors: MCP servers over stdio or HTTP, a catalog (filesystem, memory,
  git, fetch, time, Junos and more), per-tool Allow / Ask / Off, logs, restart.
  Replaces the old MCP panel; `mcp-servers.json` entries are imported once.
- Settings sheet (Cmd+,) replaces the Options menu: Access, Connectors,
  Chat tools, Voice, Remote Control, Labs.
- Local MCP servers start and stop with Mirabilis; no separate script.
  The Junos preset finds `~/junos-mcp-server` and runs it with its own venv.
- On/off switch for Mirabilis's own MCP server (`mcp-endpoint.json`).
- Connectors are labeled Local, Local URL or Remote.
- Desktop quits gracefully, so connector processes stop with the app.
- Run log redaction covers bearer tokens, `*_token` keys and URL passwords.
- Token count under the composer opens the context breakdown.
- UI copy trimmed across menus, Settings, sheets and IntelLedger.
- Sub-agents share the parent budget, two at a time by default.
- `POST /api/agent/runs` streams progress; stop kills the process group.
- Run panel with tool calls and budget meters.
- Fixed: command blocklist gaps (`rm -rf $HOME`, `--no-preserve-root`).
- Fixed: path jail checks real paths, so symlinks cannot escape the root.
- `search_files` is case-insensitive by default.
- CI and release builds on macos-15; GitHub Actions on Node 24.

## [26.3R1-S1] - 2026-07-19

- Vision input; managed llama.cpp runtime (KV-cache quant, flash attention).
- vLLM provider, local on NVIDIA/CUDA or remote; runtime registry.
- `auto` model router per task lane; hardware auto-tune of context and threads.
- Local streaming: adaptive timeouts, OOM retry, first-token and stall watchdogs.
- Voice chat transcribes with local whisper.cpp.
- KaTeX math, exact token counts, searchable grouped provider picker.
- Security: llama.cpp model refs, digests and paths validated against traversal.

## [26.2R1-S33] - 2026-07-18

- Config Vault: cited on-device retrieval over a chosen folder.
- Inference Cockpit for local Ollama sampling, context, GPU layers and seed.
- Performance Receipt: tokens/sec, time to first token, model-fit estimate.
- Voice Chat with Piper voices; Uncensored and web search composer toggles.

## [26.2R1-S32] - 2026-07-13

- Effort control (Fast, Balanced, Deep) and a running token total.
- Image service starts in the background; `MIRABILIS_SKIP_IMAGE=1` skips it,
  `MIRABILIS_WAIT_IMAGE=1` waits for it.

## [26.2R1-S31] - 2026-07-13

- Go Dark: local-only lockdown, enforced in the UI and at the send path.
- Privacy Receipt: each reply marked on-device or with its remote provider.
- Off the Record: in-memory chat, never written to disk.
- Recall Orb, Commitment Radar, Homelab Roster, Watched Workspace and more.
- Local Change Journal snapshots files before MCP writes.

## [26.2R1-S30] - 2026-07-12

- ICQ flower logo system; collapsible sidebar.

## [26.2R1-S29] - 2026-07-12

- Security: loopback bind, Host-header guard, `/mcp` token, SSRF guard, keys
  in a header instead of the URL.
- Atomic store writes with `.bak` recovery; Cerebras provider; "To Ledger".
- CI test gate, per-OS `SHA256SUMS`, pinned KoboldCpp.

## [26.2R1-S28] - 2026-04-25

- Helmet, compression, rate limiting, stricter CORS, graceful shutdown.
- `desktop/build.sh` uses strict mode and `npm ci`.

## [26.2R1-S27] - 2026-04-25

- IntelLedger: readable revision labels, layout fixes, memoized rendering.

## [26.2R1-S26] - 2026-04-24

- Electron desktop app: `desktop/build.sh` (macOS), `build.bat` (Windows).

## [26.2R1-S25] - 2026-04-23

- Instruction profiles saved per chat; chat branches and snapshots.
- Install and uninstall llama-server and KoboldCpp from the provider picker.

## [26.2R1-S24] - 2026-04-13

- Providers: OpenRouter, Groq, GPUaaS, OpenAI, Grok, Gemini, Claude.
- Per-provider hints, budget bar and `auto` model; stall watchdog.
- No automatic fallback from a remote provider to Ollama.

## [26.2R1-S23] - 2026-04-13

- System prompt reflects whether the active provider is local or remote.

## [26.2R1-S22] - 2026-04-13

- Fixed hydration warnings, loopback CORS and a nested button.

## [26.2R1-S21] - 2026-04-12

- `node run.js` installs missing dependencies before starting.

## [26.2R1-S20] - 2026-04-12

- Ollama and OpenAI-compatible provider adapters added.

## [26.2R1-S19] - 2026-04-12

- Shell scripts removed; everything runs through `node run.js`.

## [26.2R1-S18] - 2026-04-12

- `node run.js logs` tails backend, frontend and image-service logs.

## [26.2R1-S17] - 2026-04-12

- Install and uninstall implemented in `run.js`.

## [26.2R1-S16] - 2026-04-12

- Backend start failures print the last log lines; installer validates.

## [26.2R1-S15] - 2026-04-12

- Installer checks for Ollama first.

## [26.2R1-S14] - 2026-04-12

- Smaller platform prompt; bounded history window.

## [26.2R1-S13] - 2026-04-12

- `install` and `uninstall` subcommands in `run.js`.

## [26.2R1-S12] - 2026-04-12

- Launcher cutover requirements documented.

## [26.2R1-S11] - 2026-04-12

- Server-side model install jobs with status and cancel.

## [26.2R1-S10] - 2026-04-12

- MCQ models install from the UI by building from local Modelfiles.

## [26.2R1-S9] - 2026-04-12

- `training/mcq/setup.sh` preflight checks, base-model pulls and `--lite`.

## [26.2R1-S8] - 2026-04-12

- `doctor` and `restart` commands; PID state file for stop; readiness checks.

## [26.2R1-S7] - 2026-04-12

- Launcher fixes: GGUF download, command detection, `npm.cmd` on Windows.

## [26.2R1-S6] - 2026-04-12

- `run.js` launcher added alongside `run.sh`.

## [26.2R1-S5] - 2026-04-12

- MCP system tools; `write_file` and `run_command` need `confirmed: true`.

## [26.2R1-S4] - 2026-04-12

- MCP server at `POST /mcp`; `--log` enables MCP output and audit log.

## [26.2R1-S3] - 2026-04-10

- MCQ model family: Pro-12B, Ultra-31B, Raw-8B (unrestricted).
- Uncensored directive placed first in the system prompt; web search chip.
- Color schemes, syntax highlighting; fixed inline code and cleared chats.

## [26.2R1] - 2026-04-08

- Chat search, rename, export, pin; temperature and max tokens.
- Serialized chat store writes with an epoch guard.

## [26.2R1] - 2026-04-06

- Unified launcher; canonical names `ollama`, `openai-compatible`, `koboldcpp`.
- All CPU cores by default (`MIRABILIS_THREADS`); `stop` command.
