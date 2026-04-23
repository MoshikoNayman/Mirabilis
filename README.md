# Mirabilis AI

**Version:** 26.3R1-S25  
**Author:** Moshiko Nayman

Mirabilis AI is a privacy-first, locally-run AI assistant with a Next.js frontend, Express backend, and support for both local inference engines and remote AI providers. Run entirely on your own machine or connect to any cloud API-your choice, per conversation.

---

## Quick Start

```bash
node run.js
```

Open: **http://localhost:3000**

`node run.js` starts the backend, frontend, image service, and any configured local providers. **Dependencies are installed automatically on first run** - no separate install step needed. No shell scripts required.

> To install or reinstall dependencies explicitly: `node run.js install`

---

## AI Providers

Mirabilis supports local and remote providers, switchable live from the UI. Configure base URL and API key per provider in the **Configure endpoint** panel.

### Local Providers

| Provider | Description | Startup |
|---|---|---|
| **Ollama** | Default local inference engine. Pull and manage models from the UI. | `node run.js ollama` |
| **Local/Custom Endpoint** | Any OpenAI-compatible local server: LM Studio, llama-server, llama.cpp, Oobabooga, etc. | `node run.js openai-compatible` |
| **KoboldCpp** | KoboldCpp local engine. Install directly from the provider dropdown if not present. | `node run.js koboldcpp` |

### Remote Providers

All remote providers require an API key. Configure in the **Configure endpoint** panel inside the app.

| Provider | Base URL | Free Tier | Key Format |
|---|---|---|---|
| **OpenAI** | `https://api.openai.com/v1` | No | `sk-...` |
| **Grok** (xAI) | `https://api.x.ai/v1` | No | `xai-...` |
| **Groq** | `https://api.groq.com/openai/v1` | Yes | `gsk_...` |
| **OpenRouter** | `https://openrouter.ai/api/v1` | Yes | `sk-or-...` |
| **Gemini** | `https://generativelanguage.googleapis.com/v1beta/openai` | Yes | `AIza...` |
| **Claude** (Anthropic) | `https://api.anthropic.com` | No | `sk-ant-...` |
| **GPUaaS Endpoint** | Your endpoint URL | Varies | Provider-specific |

> **GPUaaS Endpoint** works with any OpenAI-compatible GPU-as-a-service: Together AI, Fireworks, RunPod OpenAI proxy, vLLM gateway, and similar platforms. Enter the base URL and API key from your provider.

### Provider UX

- Dropdown shows **Local** / **Remote** scope under each provider name.
- Local providers that require a binary (`llama-server`, `KoboldCpp`) are **greyed out** when not installed - click **Install** inline to download and install automatically, or **Uninstall** to remove.
- Per-provider hint banner in the config panel shows the expected base URL and key format.
- **Estimated monthly budget bar** - set a USD budget; the bar tracks estimated token spend against it (shown for all remote providers).
- **Auto model resolution** - selecting `auto` picks a sensible default model per provider (e.g. `gpt-4o-mini` for OpenAI, `llama-3.1-8b-instant` for Groq, `openai/gpt-4o-mini` for OpenRouter).
- **Stream stall watchdog** - aborts a stalled local stream after 120 s with a clear timeout message.
- No forced fallback: if a remote provider is unreachable, an error is shown rather than silently switching to Ollama.

---

## Commands

All operations run pure JavaScript - no shell scripts required.

```
node run.js                        # Start (UI provider selection)
node run.js ollama                 # Start with Ollama
node run.js openai-compatible      # Start with llama-server
node run.js koboldcpp              # Start with KoboldCpp
node run.js install                # Install / reinstall all dependencies
node run.js uninstall              # Remove dependencies and caches
node run.js stop                   # Stop all running services
node run.js restart [provider]     # Restart services
node run.js doctor                 # Validate environment
node run.js logs                   # Real-time log tail (for debugging)
node run.js --help                 # Show full help
```

### Flags

```
--log                 # Stream backend logs to terminal
--verbose             # Extended startup diagnostics
```

### Examples

```bash
node run.js                                    # Default: choose provider in UI
node run.js ollama --verbose                   # Ollama + detailed diagnostics
node run.js restart openai-compatible --log    # Restart + live log tail
node run.js logs                               # Watch all service logs
node run.js doctor                             # Check environment health
```

---

## Verification

```bash
node run.js doctor
curl -sS http://127.0.0.1:4000/health
curl -sS http://127.0.0.1:4000/api/models
curl -sS "http://127.0.0.1:4000/api/providers/health?provider=ollama"
```

---

## Features

| Category | Feature |
|---|---|
| **Chat** | Streaming AI chat with persistent local history |
| **Chat** | Built-in and custom instruction profiles, persisted per chat |
| **Chat** | Chat branching and restore snapshots for safe experimentation |
| **Chat** | File attachments and image messages per conversation |
| **Chat** | Canvas mode, Deep Thinking mode, Guided Learning mode |
| **Providers** | 10 providers: Ollama, OpenAI, Grok, Groq, OpenRouter, Gemini, Claude, GPUaaS, Custom Endpoint, KoboldCpp |
| **Providers** | Live provider health check; switch provider per session from the UI |
| **Providers** | Pull, delete, and monitor Ollama models from the UI |
| **Providers** | Estimated remote spend tracker with configurable monthly budget |
| **Image Generation** | Local image generation via image-service (Stable Diffusion, port 7860) |
| **Voice / TTS** | Text-to-speech with Piper neural voices; download models from the UI |
| **Voice / TTS** | Browser speech synthesis fallback; rate and pitch controls |
| **Web Search** | Automatic web search classification; enriches answers with live results |
| **Remote Execution** | SSH or local remote control - run commands and read files from the UI |
| **System Monitor** | Live CPU/RAM utilization, hardware profile, system specs |
| **Training / Memory** | Personal memory store, fine-tuning examples, dataset export |
| **MCP Client** | Connect to external MCP servers with per-server tool approval policy |
| **MCP Server** | Exposes Mirabilis as an MCP server to VS Code / GitHub Copilot / Claude Desktop |
| **MCP Server** | System control tools: `system_info`, `list_dir`, `read_file`, `write_file`, `run_command` |
| **MSQ Models** | Custom model family (Raw-8B, Pro-12B, Ultra-31B) tuned for Mirabilis |

---

## CPU / Thread Control

For `openai-compatible` and `koboldcpp`, Mirabilis uses all logical CPU cores by default.

```bash
MIRABILIS_THREADS=8 node run.js openai-compatible
MIRABILIS_THREADS=8 node run.js koboldcpp
```

---

## MCP Server

Mirabilis exposes itself as an MCP server at:

```
POST http://127.0.0.1:4000/mcp
```

### Exposed Tools

| Tool | Description |
|---|---|
| `mirabilis_chat` | Send a prompt and get a streaming AI response (provider + model selectable) |
| `mirabilis_list_models` | List available models for a given provider |
| `mirabilis_health` | Check readiness of all configured providers |
| `system_info` | OS, platform, architecture, hostname, home dir, cwd |
| `list_dir` | List files and directories at a path |
| `read_file` | Read a file's text content (≤ 512 KB) |
| `write_file` | Write/overwrite a file - requires `confirmed: true` |
| `run_command` | Run a shell command (macOS/Linux/Windows) - requires `confirmed: true` |

### Connect from VS Code

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "mirabilis": {
      "url": "http://127.0.0.1:4000/mcp",
      "description": "Mirabilis local AI - start with node run.js first"
    }
  }
}
```

Then ask Copilot Chat: `Use mirabilis_chat to explain BGP` or `Call mirabilis_health`.

### Audit Logging

Pass `--log` to enable live terminal output and write an audit log to `backend/data/mcp-server-audit.jsonl`:

```bash
node run.js --log
```

---

## MCP Client

Mirabilis can connect **to** external MCP servers (Junos, Synology, Debian, etc.) from the UI. Configure servers in the **MCP** panel. Connections are persisted in `backend/data/mcp-servers.json`.

---

## Chat Workflow

- **Instruction profiles**: Choose from built-in instruction profiles or save your current instructions as a custom reusable profile.
- **Per-chat instructions**: Mirabilis now keeps the selected profile and current instructions with each chat, so switching conversations does not silently reset your setup.
- **Branch chat**: Clone the current conversation into a new branch before trying a different prompt, model, or reasoning path.
- **Snapshots**: Save restore points for an active chat, then roll back to a selected snapshot later from the chat header.

---

## Architecture

Mirabilis is 100% pure JavaScript for all launcher and lifecycle operations:

- **Installation** - automatic on first run; or explicitly via `node run.js install`: validates prerequisites, installs npm/Python deps, downloads provider binaries.
- **Startup** - `node run.js [provider]`: orchestrates backend (Express, port 4000), frontend (Next.js, port 3000), image-service (port 7860), and local AI providers.
- **Lifecycle** - `stop`, `restart`, `doctor`, `logs`, `uninstall`: all pure JS, no shell scripts.
- **Self-healing** - auto-installs missing dependencies on startup; auto-creates missing provider adapter files.
- **No shell dependencies** - works cross-platform without any `.sh` wrappers.

```text
frontend/       Next.js UI (React, Tailwind)
backend/        Express API + provider adapters
  src/
    providers/  ollama.js, openaiCompatible.js, anthropic.js
    modelService.js
    server.js
image-service/  Local Stable Diffusion image generation
providers/      Local runtime binaries (llama-server, koboldcpp)
training/msq/   MSQ model family - Modelfiles and setup script
config/         default.json - port, model, and path configuration
run.js          Unified launcher, installer, doctor, logs, and cleanup
```

---

## MSQ Model Family

MSQ is a custom model family created by Moshiko Nayman, built on publicly available base models and tuned specifically for Mirabilis workflows. Install via `training/msq/setup.sh` or pull directly through the Ollama panel in the UI.

| Model             | Base                           | Params | Context | Character                                     |
|-------------------|--------------------------------|-------:|--------:|-----------------------------------------------|
| **MSQ-Raw-8B**    | dolphin3 / Llama 3.1 (4.9 GB) |     8B |   8 192 | Fast local inference. Fully unrestricted, no safety filters. |
| **MSQ-Pro-12B**   | gemma3:12b (8.1 GB)            |    12B |  32 768 | Balanced quality and speed. Thorough, deep reasoning. Everyday workhorse. |
| **MSQ-Ultra-31B** | gemma4:31b (~20 GB)            |    31B |  65 536 | Maximum local quality. Flagship depth and reasoning. |

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
