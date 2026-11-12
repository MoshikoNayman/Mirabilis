# Mirabilis AI

Version 26.4R1-S1. Author: Moshiko Nayman.

Mirabilis is a local-first AI chat app. It runs a model on your own machine
through Ollama or another local engine, or talks to a cloud provider with your
own key, chosen per conversation. Chats and other data stay on disk locally
unless you pick a remote provider. It ships with IntelLedger, a workspace that
pulls decisions, risks, asks and commitments out of conversations and tracks
them.

## Requirements

Node.js 18 or newer.

| Platform | Install |
|---|---|
| macOS | `brew install node` |
| Linux | `sudo apt install nodejs npm` |
| Windows | `winget install OpenJS.NodeJS` |

## Quick start

```bash
node run.js
```

Then open http://localhost:3000.

On first run the launcher installs what is missing (npm packages, the image
service venv, Ollama) and starts the backend (port 4000), the frontend (port
3000), the image service (port 7860) and Ollama. The same command works on
macOS, Linux and Windows.

```bash
node run.js --no-image      # skip the image service (torch/diffusers, several GB)
node run.js --no-ollama     # do not install or start Ollama; cloud providers only
node run.js --all-engines   # also start llama-server and KoboldCpp
node run.js dev             # hot reload for frontend and backend
node run.js doctor          # check the install and the data folder
node run.js stop            # stop everything the launcher started
```

Other modes:

```bash
node run.js ollama              # start with Ollama
node run.js openai-compatible   # start with llama-server
node run.js koboldcpp           # start with KoboldCpp
node run.js install             # install or repair dependencies
node run.js restart [mode]      # stop, then start
node run.js logs                # tail backend, frontend and image-service logs
node run.js uninstall           # remove dependencies and caches
node run.js --help
```

Flags: `--log` prints live backend and MCP logs and writes the MCP audit log,
`--verbose` prints more startup detail, `--dev-ui` runs only the frontend with
hot reload.

`doctor` exits non-zero only when something required is missing. A service that
is not running is reported as a note.

`uninstall` removes `node_modules`, the image-service venv, `backend/.env`,
`frontend/.env.local` and the launcher's downloaded model. It does not touch the
data folder.

## Providers

Pick the provider in the UI and set its base URL and key in the Configure
endpoint panel.

| Provider | Where it runs |
|---|---|
| Ollama (default) | Local |
| llama.cpp (managed `llama-server`) | Local |
| Local/Custom Endpoint (any OpenAI-compatible server) | Local or remote |
| KoboldCpp | Local |
| vLLM | Local on NVIDIA/CUDA, or a remote server by URL |
| GPUaaS Endpoint | Remote, any OpenAI-compatible GPU host |
| OpenAI, Claude, Gemini, Grok, Groq, OpenRouter, Cerebras | Cloud, your API key |

Base URLs, key formats, the model catalog and the MCQ models are in
[docs/PROVIDERS.md](docs/PROVIDERS.md).

### Uncensored models

An Uncensored toggle in the composer is off by default. Turning it on for a chat
switches to an installed uncensored local model, if there is one, and puts a
directive at the top of the system prompt that drops the app's content
restrictions. The model list has an Uncensored group (Dolphin variants, Wizard
Vicuna Uncensored, Llama 2 Uncensored) and MCQ-Raw-8B, which has no safety
filters. These run locally on hardware you control.

## Go Dark

Go Dark is a local-only lockdown. While it is on, the backend refuses any
outbound request to a host that is not this machine or the local network, so
remote providers, web search, registry lookups and SSH to outside hosts are
blocked, and the desktop app does not check for updates. The state is stored in
the data folder and survives a restart.

## Access and Connectors

Access decides what the assistant may do on this computer. Set it from the
Access chip in the composer or in Settings: Chat only (the default, no tools),
Read only (reads files, inspects the system and runs read-only commands, never
changes anything), Ask first (asks before every change) or Bypass (runs
everything without asking). With tools on, Mirabilis can troubleshoot this
computer and explain how it is built from its own source. Every action goes to
the run log in the data folder, and every file change keeps a copy of the old
file.

Connectors add tools from MCP servers. Pick one from the catalog (Filesystem,
Git, Fetch, Junos and more) or add any local command or remote URL, then set
each tool to Allow, Ask or Off. See [docs/MCP.md](docs/MCP.md). The built-in
This computer connector holds the troubleshooting tools: processes, disks,
logs, services, hardware and network checks. Switched off, its process stops
and its tools leave agent runs.

## Features

- Streaming chat with local history, instruction profiles, branches and snapshots
- Attachments, image input for vision models, LaTeX math
- Answer styles (Instant to Deep) and autonomous runs (High effort, 1 hour,
  5 hours) with a hard budget
- Config Vault: cited local retrieval over a folder you choose
- Recall over past chats and IntelLedger signals, on-device embeddings
- Inference controls for Ollama models and per-reply tokens/sec
- Voice chat with local whisper.cpp and Piper voices
- Web search through Tavily (needs `TAVILY_API_KEY`)
- Local image generation (Stable Diffusion)
- SSH remote execution and a homelab host list
- MCP server, and Connectors as an MCP client, see [docs/MCP.md](docs/MCP.md)

## Desktop app

Installers are on the
[latest release](https://github.com/MoshikoNayman/Mirabilis/releases/latest):
`-arm64.dmg` for macOS (Apple Silicon), `-x64.exe` for Windows, `-x86_64.AppImage`
for Linux. Each release has `SHA256SUMS-<os>.txt` for checking the download.

The macOS build is not notarized yet. If macOS says the app is damaged, run
`xattr -cr "/Applications/Mirabilis AI.app"` once.

To build from source:

```bash
cd desktop
./build.sh dmg        # macOS
./build.sh appimage   # Linux
build.bat             # Windows
```

Signing, updates and release details are in [docs/DESKTOP.md](docs/DESKTOP.md).

## Where data lives

All app data is in one folder: `../mirabilis-data` beside the repo when run from
source, or the per-app data folder when run as the desktop app. Set
`MIRABILIS_DATA_DIR` to move it. It holds chats, IntelLedger, the config vault
index, personal memory, provider keys, Access settings, connectors, agent run
logs and the MCP token. Files are written `0600` and the folder `0700`.

## Configuration

Nothing is required. Every setting is an environment variable; copy
`backend/.env.example` to `backend/.env` to set them. Keep
`MIRABILIS_BIND_HOST` on loopback: the API includes endpoints that run shell
commands.

## Docs

- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): environment variables, Access levels, data files
- [docs/PROVIDERS.md](docs/PROVIDERS.md): providers, models, MCQ family
- [docs/MCP.md](docs/MCP.md): MCP server and Connectors
- [docs/DESKTOP.md](docs/DESKTOP.md): installers, building, signing, updates
- [CHANGELOG.md](CHANGELOG.md)

## Layout

```text
run.js          launcher, installer, doctor, logs, cleanup
backend/        Express API, providers, agent, MCP
frontend/       Next.js UI
image-service/  Stable Diffusion service (Python)
desktop/        Electron packaging
training/mcq/   MCQ Modelfiles and setup script
```

## Legal

Copyright (c) 2026 Moshiko Nayman. All rights reserved. See `LICENSE`.
