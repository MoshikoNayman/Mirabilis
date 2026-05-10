# Mirabilis AI

**Version:** 26.2R1-S28  
**Author:** Moshiko Nayman

[![Download Latest Release](https://img.shields.io/badge/Download-Latest%20Release-1aa86f?style=for-the-badge)](https://github.com/MoshikoNayman/Mirabilis/releases/latest)

Default recommendation: use the desktop installer from Releases (macOS DMG / Windows EXE). Source/web mode is available for advanced users.

Mirabilis AI is a privacy-first, locally-run AI assistant with a Next.js frontend, Express backend, and support for both local inference engines and remote AI providers. Run entirely on your own machine or connect to any cloud API-your choice, per conversation.

---

## Prerequisites

**Node.js 18+** must be installed before running Mirabilis.

| Platform | Install |
|---|---|
| macOS | `brew install node` |
| Linux | `sudo apt install nodejs npm` or see [nodejs.org](https://nodejs.org) |
| FreeBSD / Solaris | `pkg install node` / `pkgadd nodejs` or build from [nodejs.org](https://nodejs.org) |
| Windows | `winget install OpenJS.NodeJS` |

---

## Quick Start

```bash
node run.js
```

Open: **http://localhost:3000**

`node run.js` starts the backend, frontend, image service, and any configured local providers. **Dependencies are installed automatically on first run** - no separate install step needed. No shell scripts required.

> To install or reinstall dependencies explicitly: `node run.js install`

---

## Desktop Downloads (Recommended)

Mirabilis supports both:

- **Web mode** (run from source with `node run.js`)
- **Desktop app** (prebuilt installers)

Download desktop installers from the latest public release:

- macOS (Apple Silicon): [Mirabilis.AI-26.2.25-arm64.dmg](https://github.com/MoshikoNayman/Mirabilis/releases/download/26.2R1/Mirabilis.AI-26.2.25-arm64.dmg)
- Windows (x64): [Mirabilis.AI.Setup.26.2.25.exe](https://github.com/MoshikoNayman/Mirabilis/releases/download/26.2R1/Mirabilis.AI.Setup.26.2.25.exe)
- Linux (x64): [Mirabilis.AI-26.2.25.AppImage](https://github.com/MoshikoNayman/Mirabilis/releases/download/26.2R1/Mirabilis.AI-26.2.25.AppImage)

---

## Public Repo Notes

Mirabilis is built to be local-first.

- Chats, IntelLedger session data, prompt profiles, and local runtime state stay on your machine unless you intentionally connect a remote provider or external service.
- Cloud providers are optional. If you use one, you bring your own API key and endpoint configuration.
- Desktop release artifacts may be packaged before Apple signing/notarization is configured for every release cycle. When that happens, the app can still be built and run locally, but macOS may show its normal unsigned-app warning.

If you prefer, you can always build Mirabilis directly from this repository instead of relying on prebuilt desktop artifacts.

---

## IntelLedger in 60 Seconds

IntelLedger is the built-in memory workspace for turning messy conversations into clear decisions and next steps.

- Create a session for a topic (incident, project, customer thread, etc.)
- Ingest text or media notes
- Auto-extract signals such as risks, asks, commitments, and decisions
- Generate session synthesis and action-focused summaries
- Track prompt provenance and audit trails with human-readable labels

If you want structured follow-through instead of raw chat history, use the InteLedger tab.

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

### Quick Cleanup (Safe)

Use the built-in cleanup helper to remove generated artifacts without touching session/chat data.

```bash
# Preview only (no deletion)
./scripts/cleanup-safe.sh

# Apply safe cleanup
./scripts/cleanup-safe.sh --apply
```

Optional deep cleanup flags:

- `--with-heavy-cache` (image-service cache)
- `--with-venv` (Python virtualenvs)
- `--with-node-modules` (forces reinstall on next run)
- `--with-runtime-data` (deletes runtime uploads/media data)

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
| **IntelLedger** | Session-based memory workspace for context capture and structured follow-through |
| **IntelLedger** | Signal extraction for risks, asks, commitments, opportunities, and decisions |
| **IntelLedger** | Session synthesis, cross-session synthesis, and action-oriented next-step tracking |
| **IntelLedger** | Prompt registry with version activation plus provenance and audit visibility |
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
| **MCQ Models** | Custom model family (Raw-8B, Pro-12B, Ultra-31B) tuned for Mirabilis |
| **Desktop App** | Package as a native macOS `.app` or Windows `.exe` from the `desktop/` folder |

---

## Desktop App

If you just want to install and run Mirabilis, use the **Desktop Downloads** section above.

Mirabilis can be packaged as a native desktop app (Electron) using the `desktop/` folder.
The build system stages everything in a temp directory and cleans up automatically — no mess.

### macOS

```bash
cd desktop
./build.sh
```

Output: `desktop/dist/mac-arm64/Mirabilis AI.app`  
Copy to `/Applications` or double-click to run.

To create a desktop-friendly installer image instead of the unpacked app bundle:

```bash
cd desktop
./build.sh dmg
```

Output: `desktop/dist/Mirabilis AI-26.2.25-arm64.dmg` (filename may vary slightly by electron-builder version).

For full Gatekeeper-friendly distribution, macOS signing/notarization still requires:

- a valid `Developer ID Application` certificate in Keychain
- notarization credentials configured for `xcrun notarytool`

Without those, Mirabilis can still be packaged locally, but macOS will treat it as an unsigned app.

### Windows

```bat
cd desktop
build.bat
```

Output: `desktop/dist/Mirabilis AI Setup.exe` (NSIS installer with custom install directory + desktop shortcut).

> **Requirements:** Node.js 18+ must be installed on the machine running the build. The resulting app is self-contained and does not require Node.js on the end-user machine.

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
training/mcq/   MCQ model family - Modelfiles and setup script
config/         default.json - port, model, and path configuration
run.js          Unified launcher, installer, doctor, logs, and cleanup
```

---

## MCQ Model Family

MCQ is a custom model family created by Moshiko Nayman, built on publicly available base models and tuned specifically for Mirabilis workflows. Install via `training/mcq/setup.sh` or pull directly through the Ollama panel in the UI.

| Model             | Base                           | Params | Context | Character                                     |
|-------------------|--------------------------------|-------:|--------:|-----------------------------------------------|
| **MCQ-Raw-8B**    | dolphin3 / Llama 3.1 (4.9 GB) |     8B |   8 192 | Fast local inference. Fully unrestricted, no safety filters. |
| **MCQ-Pro-12B**   | gemma3:12b (8.1 GB)            |    12B |  32 768 | Balanced quality and speed. Thorough, deep reasoning. Everyday workhorse. |
| **MCQ-Ultra-31B** | gemma4:31b (~20 GB)            |    31B |  65 536 | Maximum local quality. Flagship depth and reasoning. |

### Setup

Requires Ollama. Run once to create all three models:

```bash
bash training/mcq/setup.sh
```

If Ultra is too heavy (download/memory), install a lighter set first:

```bash
bash training/mcq/setup.sh --lite
```

The setup script now auto-pulls missing base models and prints clear diagnostics when a pull/create fails.

Models will appear in the **MCQ** group at the top of the model selector after setup.

You can also install MCQ models directly from the UI model menu in Ollama mode; Mirabilis now builds `mcq-*` models from local Modelfiles when you click Install.

Model installs now run as server-side jobs (with status persistence and cancel support), so refresh/reload does not lose install state.

> **MCQ-Ultra-31B** requires ~20 GB RAM/VRAM. Works on Apple Silicon Macs with 24 GB+ unified memory.
>
> **MCQ-Raw-8B** disables all content filters. Use responsibly and only on hardware you control.

## Notes

- Provider names are canonical and consistent across launcher, backend, and UI.
- If a provider is unavailable, UI can still fall back to Ollama when reachable.
- Chat history is local (`backend/data/chats.json`).

## Legal

Copyright (c) 2026 Moshiko Nayman. All rights reserved.
See `LICENSE` for terms.
