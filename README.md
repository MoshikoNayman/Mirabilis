# Mirabilis AI

Version: 26.2R1
Owner and Builder: Moshiko Nayman

Mirabilis AI is a local-first assistant app with a Next.js frontend, Express backend, and optional local inference engines.

## Quick Start

```bash
./install.sh
./run.sh
```

Open: http://localhost:3000

`./run.sh` starts Mirabilis and launches all available local providers for direct switching from the UI.

## Canonical Providers

- `ollama`
- `openai-compatible` (backed by local `llama-server`)
- `koboldcpp`

Run modes:

```bash
./run.sh                  # UI mode (auto-start local providers)
./run.sh ollama
./run.sh openai-compatible
./run.sh koboldcpp
./run.sh stop
```

## CPU / Core Usage

For `openai-compatible` and `koboldcpp`, Mirabilis uses all logical CPU cores by default.

Override thread count:

```bash
MIRABILIS_THREADS=8 ./run.sh openai-compatible
MIRABILIS_THREADS=8 ./run.sh koboldcpp
```

## Project Structure

```text
frontend/       Next.js UI
backend/        Express API + provider adapters
image-service/  Local image generation service
providers/      Local runtime binaries (llama-server, koboldcpp)
install.sh      One-time setup
run.sh          Unified launcher and stop command
uninstall.sh    Cleanup script
```

## Notes

- Provider names are canonical and consistent across launcher, backend, and UI.
- If a provider is unavailable, UI can still fall back to Ollama when reachable.
- Chat history is local (`backend/data/chats.json`).

## Legal

Copyright (c) 2026 Moshiko Nayman. All rights reserved.
See `LICENSE` for terms.
