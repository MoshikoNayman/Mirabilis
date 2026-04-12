# Mirabilis AI

Version: 26.3R1-S7
Owner and Builder: Moshiko Nayman

Mirabilis AI is a local-first assistant app with a Next.js frontend, Express backend, and optional local inference engines.

## Quick Start

```bash
./install.sh
./run.sh
```

Open: http://localhost:3000

`./run.sh` starts Mirabilis and launches all available local providers for direct switching from the UI.

`run.sh` now acts as a safe fallback wrapper that delegates to `run.js`.

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
./run.sh                          # UI mode (auto-start local providers)
./run.sh ollama
./run.sh openai-compatible
./run.sh koboldcpp
./run.sh stop
./run.sh --log                    # Any mode with live backend + MCP logs
./run.sh ollama --log

# Direct JavaScript launcher (same behavior)
node run.js
node run.js ollama
node run.js stop
```

## CPU / Core Usage

For `openai-compatible` and `koboldcpp`, Mirabilis uses all logical CPU cores by default.

Override thread count:

```bash
MIRABILIS_THREADS=8 ./run.sh openai-compatible
MIRABILIS_THREADS=8 ./run.sh koboldcpp
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
      "description": "Mirabilis local AI — start with ./run.sh first"
    }
  }
}
```

Then ask Copilot Chat: `Use mirabilis_chat to explain BGP` or `Call mirabilis_health`.

### Logging

By default, no logs are written and no console output is produced.
Pass `--log` to enable live terminal output and audit file (`backend/data/mcp-server-audit.jsonl`):

```bash
./run.sh --log
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
install.sh      One-time setup
run.sh          Unified launcher and stop command
uninstall.sh    Cleanup script
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

Models will appear in the **MSQ** group at the top of the model selector after setup.

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
