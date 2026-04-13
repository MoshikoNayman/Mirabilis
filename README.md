# Mirabilis AI

Version: 26.3R1-S21
Owner and Builder: Moshiko Nayman

Mirabilis AI is a local-first assistant app with a Next.js frontend, Express backend, and optional local inference engines.

## Quick Start

```bash
node run.js install
node run.js
```

Ollama is a required runtime for the default `ui` startup flow.

Open: http://localhost:3000

`node run.js` starts Mirabilis and launches all available local providers for direct switching from the UI.

## Commands

All operations run pure JavaScript—no shell scripts required.

```
node run.js                        # Start with UI provider selection
node run.js ollama                 # Start with Ollama
node run.js openai-compatible      # Start with llama-server
node run.js koboldcpp              # Start with KoboldCpp
node run.js install                # Install/reinstall dependencies
node run.js uninstall              # Remove dependencies and caches
node run.js stop                   # Stop running services
node run.js restart [provider]     # Restart services
node run.js doctor                 # Validate environment
node run.js logs                   # Real-time log tail (for debugging)
node run.js --help                 # Show full help
```

## Flags

```
--log                 # Stream backend logs to terminal
--verbose             # Extended startup diagnostics
```

## Examples

```bash
node run.js                        # Default: choose provider from UI
node run.js ollama --verbose       # Start with Ollama + detailed output
node run.js restart openai-compatible --log  # Restart with OpenAI-compatible + logs
node run.js logs                   # Debug: watch real-time service logs
node run.js doctor                 # Check environment health
```

## Verification

```bash
node run.js doctor
node run.js logs &          # Background
node run.js --verbose       # In another terminal
curl -sS http://127.0.0.1:4000/health
curl -sS http://127.0.0.1:4000/api/models
curl -sS http://127.0.0.1:4000/api/models/install-jobs
```

## Architecture

Mirabilis is 100% pure JavaScript for the launcher and all lifecycle operations:
- **Installation**: `node run.js install` — validates prerequisites, installs npm/Python deps, downloads provider binaries
- **Startup**: `node run.js [provider]` — orchestrates backend, frontend, image-service, and AI providers
- **Lifecycle**: `stop`, `restart`, `doctor`, `logs`, `uninstall` — all pure JS, no shell scripts
- **No shell dependencies** — works cross-platform without shell script fallbacks
- **Autonomous** — fully self-contained; no shell wrappers required

No shell scripts (`install.sh`, `run.sh`, `uninstall.sh`) are included in this repo. All operations via `node run.js`.

## Features

| Category | Feature |
|---|---|
| **Chat** | Streaming AI chat with persistent local history |
| **Chat** | File attachments per conversation |
| **Chat** | Image messages (send/receive images in chat) |
| **Providers** | Ollama, openai-compatible (llama-server), koboldcpp |
| **Providers** | Live provider health check and model switching from the UI |
| **Providers** | Pull and delete Ollama models from the UI |
| **Image Generation** | Local image generation via image-service (port 7860) |
| **Voice / TTS** | Text-to-speech using Piper; download models from the UI |
| **Web Search** | Search the web from within a chat conversation |
| **Remote Execution** | Connect to a remote server and run commands from the UI |
| **System Monitor** | Live CPU/RAM utilization, hardware profile, system specs |
| **Training / Memory** | Store training examples and memory entries; export dataset |
| **MCP Client** | Connect to external MCP servers (Junos, Synology, Debian, etc.) with per-server approval policy |
| **MCP Server** | Exposes Mirabilis as an MCP server to VS Code / GitHub Copilot / Claude Desktop |
| **MCP Server** | System control tools: `system_info`, `list_dir`, `read_file`, `write_file`, `run_command` |
| **MSQ Models** | Custom model family (Raw-8B, Pro-12B, Ultra-31B) tuned for Mirabilis |

## Canonical Providers

- `ollama`
- `openai-compatible` (backed by local `llama-server`)
- `koboldcpp`

Run modes:

```bash
node run.js
node run.js ollama
node run.js openai-compatible
node run.js koboldcpp
node run.js stop
node run.js doctor
node run.js restart
node run.js restart openai-compatible --log
node run.js logs
node run.js --log                 # Any mode with live backend + MCP logs
node run.js ollama --log
node run.js install
node run.js uninstall
```

## CPU / Core Usage

For `openai-compatible` and `koboldcpp`, Mirabilis uses all logical CPU cores by default.

Override thread count:

```bash
MIRABILIS_THREADS=8 node run.js openai-compatible
MIRABILIS_THREADS=8 node run.js koboldcpp
```

## MCP Server

When running, Mirabilis exposes itself as an MCP server at:

```
POST http://127.0.0.1:4000/mcp
```

### Exposed tools

| Tool | Description |
|---|---|
| `mirabilis_chat` | Send a prompt and get an AI response (provider + model selectable) |
| `mirabilis_list_models` | List available models for a given provider |
| `mirabilis_health` | Check readiness of all configured providers |
| `system_info` | OS, platform, architecture, hostname, home dir, cwd |
| `list_dir` | List files and directories at a path |
| `read_file` | Read a file's text content (≤ 512 KB) |
| `write_file` | Write/overwrite a file — requires `confirmed: true` |
| `run_command` | Run a shell command (macOS/Linux/Windows) — requires `confirmed: true` |

### Connect from VS Code

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "mirabilis": {
      "url": "http://127.0.0.1:4000/mcp",
      "description": "Mirabilis local AI — start with node run.js first"
    }
  }
}
```

Then ask Copilot Chat: `Use mirabilis_chat to explain BGP` or `Call mirabilis_health`.

### Logging

By default, no logs are written and no console output is produced.
Pass `--log` to enable live terminal output and audit file (`backend/data/mcp-server-audit.jsonl`):

```bash
node run.js --log
```

## MCP Client

Mirabilis can also connect **to** external MCP servers (Junos, Synology, Debian, etc.) from the UI.
Configure servers in the MCP panel in the app. Connections are stored in `backend/data/mcp-servers.json`.

## Project Structure

```text
frontend/       Next.js UI
backend/        Express API + provider adapters
image-service/  Local image generation service
providers/      Local runtime binaries (llama-server, koboldcpp)
training/msq/   MSQ model family — Modelfiles and setup script
run.js          Unified launcher, installer, doctor, logs, and cleanup commands
```

## MSQ Model Family

MSQ is a model family created by Moshiko Nayman, built on top of publicly available base models and tuned specifically for Mirabilis.

| Model             | Base                           | Params | Context | Character                                     |
|-------------------|--------------------------------|-------:|--------:|-----------------------------------------------|
| **MSQ-Raw-8B**    | dolphin3 / Llama 3.1 (4.9 GB) |     8B |   8 192 | Fully unrestricted. No safety filters.        |
| **MSQ-Pro-12B**   | gemma3:12b (8.1 GB)            |    12B |  32 768 | Thorough, deep reasoning. Everyday workhorse. |
| **MSQ-Ultra-31B** | gemma4:31b (~20 GB)            |    31B |  65 536 | Flagship. Maximum depth and reasoning.        |

### Setup

Requires Ollama. Run once to create all three models:

```bash
bash training/msq/setup.sh
```

If Ultra is too heavy (download/memory), install a lighter set first:

```bash
bash training/msq/setup.sh --lite
```

The setup script now auto-pulls missing base models and prints clear diagnostics when a pull/create fails.

Models will appear in the **MSQ** group at the top of the model selector after setup.

You can also install MSQ models directly from the UI model menu in Ollama mode; Mirabilis now builds `msq-*` models from local Modelfiles when you click Install.

Model installs now run as server-side jobs (with status persistence and cancel support), so refresh/reload does not lose install state.

> **MSQ-Ultra-31B** requires ~20 GB RAM/VRAM. Works on Apple Silicon Macs with 24 GB+ unified memory.
>
> **MSQ-Raw-8B** disables all content filters. Use responsibly and only on hardware you control.

## Notes

- Provider names are canonical and consistent across launcher, backend, and UI.
- If a provider is unavailable, UI can still fall back to Ollama when reachable.
- Chat history is local (`backend/data/chats.json`).

## Legal

Copyright (c) 2026 Moshiko Nayman. All rights reserved.
See `LICENSE` for terms.
