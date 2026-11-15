# Mirabilis AI

Version 26.4R1-S4. Author: Moshiko Nayman.

Mirabilis is a local-first AI chat app. It runs models on your own machine
through Ollama or another local engine, or uses a cloud provider with your own
key. Chats and other data stay on this machine unless you pick a cloud
provider.

## Install

Desktop app: download it from the
[latest release](https://github.com/MoshikoNayman/Mirabilis/releases/latest).
`-arm64.dmg` is for macOS (Apple Silicon), `-x64.exe` for Windows and
`-x86_64.AppImage` for Linux.

The macOS build is not notarized yet. If macOS says the app is damaged, run
`xattr -cr "/Applications/Mirabilis AI.app"` once.

From source, with Node.js 18 or newer:

```bash
node run.js
```

Then open http://localhost:3000. The first run installs what is missing,
including the image service, which needs several GB; `--no-image` skips it.
`node run.js --help` lists every mode and flag.

## Features

- Local models through Ollama, llama.cpp, KoboldCpp, vLLM or any
  OpenAI-compatible server
- Cloud models from OpenAI, Claude, Gemini, Grok, Groq, OpenRouter and
  Cerebras, with your own key
- Effort from Instant to Ultra. Long runs have a hard budget and up to 8
  parallel agents.
- Access levels: Chat only, Read only, Ask first, Bypass permissions
- Connectors for MCP tools, plus a built-in This computer connector for
  troubleshooting
- Go Dark: the app's own requests stay on this machine and the local network
- Web search through Tavily (needs `TAVILY_API_KEY`)
- Uncensored mode for local models: keeps an uncensored model or switches to
  one, and its refusal shield re-asks a model that refuses. Settings > Models
  has a Freedom test.
- Voice chat and dictation with local whisper.cpp and Piper voices
- Attachments, image input, LaTeX math, branches and snapshots
- Models manager for installing and updating Ollama models
- Config Vault: cited answers over a folder you choose
- Recall: search past chats by meaning
- Local image generation (Stable Diffusion)
- SSH remote execution and a homelab host list

Config Vault and Recall need an embedding model: `ollama pull nomic-embed-text`.

## Data

Everything lives in one folder: `../mirabilis-data` beside the repo, or the
app's own data folder for the desktop app. Set `MIRABILIS_DATA_DIR` to move it.
Uninstalling never touches it.

## Configuration

Nothing is required. To change a setting, copy `backend/.env.example` to
`backend/.env`. Keep `MIRABILIS_BIND_HOST` on loopback: the API can run shell
commands.

## Docs

- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): settings, Access levels, data files
- [docs/PROVIDERS.md](docs/PROVIDERS.md): providers, models, Uncensored mode
- [docs/MCP.md](docs/MCP.md): MCP server and Connectors
- [docs/DESKTOP.md](docs/DESKTOP.md): installers, building, updates
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it is built
- [CHANGELOG.md](CHANGELOG.md)

## Legal

Copyright (c) 2026 Moshiko Nayman. All rights reserved. See `LICENSE`.
