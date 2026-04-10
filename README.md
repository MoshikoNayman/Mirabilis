# Mirabilis AI

Version: 26.3R1-S3
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
