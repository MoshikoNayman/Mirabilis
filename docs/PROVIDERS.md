# Providers and models

Pick the provider in the UI. The picker groups them as Local, Remote and Cloud
APIs. Base URL and API key are set per provider in the Configure endpoint panel;
keys entered there are kept by the backend, never in the browser.

## Local

| Provider | Default endpoint | Notes |
|---|---|---|
| Ollama | `http://127.0.0.1:11434` | Default. Pull, delete and monitor models from the UI. `node run.js ollama` |
| llama.cpp | `http://127.0.0.1:8080/v1` | Managed `llama-server` that runs your existing Ollama GGUF blobs with no re-download. Exposes KV-cache quantization, flash attention and server slots. One managed server at a time. |
| Local/Custom Endpoint | `http://127.0.0.1:8000/v1` | Any OpenAI-compatible server: LM Studio, llama-server, Oobabooga, TGI. `node run.js openai-compatible` starts llama-server with a small Llama 3.2 1B GGUF. |
| KoboldCpp | `http://127.0.0.1:5001/v1` | Loads one GGUF at launch, so the model menu shows only what is loaded plus local GGUF files. `node run.js koboldcpp` |
| vLLM | `http://127.0.0.1:8000/v1` | Managed local `vllm serve` on an NVIDIA/CUDA machine, or a remote vLLM server by URL. Not launched locally on Apple Silicon. |

llama-server and KoboldCpp show as greyed out when their binary is missing; the
picker can install or uninstall them. The launcher installs pinned releases
(`MIRABILIS_LLAMACPP_TAG`, `MIRABILIS_KOBOLDCPP_TAG`) into `providers/`. In `ui`
mode they start only with `--all-engines`.

For llama-server and KoboldCpp the launcher uses every logical CPU core. Override
with `MIRABILIS_THREADS`:

```bash
MIRABILIS_THREADS=8 node run.js openai-compatible
```

## Remote and cloud

| Provider | Base URL | Free tier | Key format |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | No | `sk-...` |
| Claude (Anthropic) | `https://api.anthropic.com` | No | `sk-ant-...` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | Yes | `AIza...` |
| Grok (xAI) | `https://api.x.ai/v1` | No | `xai-...` |
| Groq | `https://api.groq.com/openai/v1` | Yes | `gsk_...` |
| OpenRouter | `https://openrouter.ai/api/v1` | Yes | `sk-or-...` |
| Cerebras | `https://api.cerebras.ai/v1` | Yes | `csk-...` |
| GPUaaS Endpoint | your URL | Varies | provider specific |

GPUaaS Endpoint is for any OpenAI-compatible GPU host: Together AI, Fireworks,
RunPod, a vLLM gateway. Claude uses a native Anthropic adapter; the rest use the
OpenAI-compatible transport.

Cloud model lists come live from each provider. When a listing fails (no key,
offline, provider down) the fallback model from `providerDefaults` in
`backend/models.json` is used.

If a remote provider is unreachable the app shows the error. It does not switch
to Ollama on its own.

The endpoint panel has an estimated monthly budget bar for remote providers,
based on token counts and per-provider rate cards.

## Go Dark and provider scope

Ollama and KoboldCpp are always on-device. OpenAI, Claude, Gemini, Grok, Groq,
OpenRouter, Cerebras and GPUaaS are always off-device. Local/Custom Endpoint,
vLLM and llama.cpp take a base URL, so they count as local only when that URL
points at this machine or the local network. Go Dark blocks anything
off-device, and an unknown provider counts as off-device.

## Model selection

With Ollama, the `auto` model picks an installed model for the kind of request
(coding, reasoning, general, experimental) within the machine's memory limit.
Context size, `low_vram` and thread counts are tuned to the device.

The Inference Cockpit under the model menu sets temperature, top-p, top-k, repeat
penalty, context window, GPU layers and a fixed seed for local Ollama models.

## Model catalog

The suggested-model list is merged from three `models.json` files, later wins:

1. `backend/models.json`, bundled
2. the copy on the repository's main branch, fetched at most hourly
   (`MIRABILIS_CATALOG_URL`)
3. `~/.mirabilis/models.json`, your own additions (`MIRABILIS_USER_CATALOG`)

Go Dark blocks the remote fetch; the bundled list covers offline use.

## MCQ models

MCQ is a model family by Moshiko Nayman, built from public base models with
Mirabilis-specific Modelfiles in `training/mcq/`.

| Model | Base | Size | Context | Use |
|---|---|---|---|---|
| MCQ-Raw-8B | `dolphin3` (Llama 3.1) | 4.9 GB | 8192 | Fast, fully unrestricted, no safety filters |
| MCQ-Pro-12B | `gemma3:12b` | 8.1 GB | 32768 | Everyday model |
| MCQ-Ultra-31B | `gemma4:31b` | ~20 GB | 65536 | Highest quality; needs about 20 GB RAM/VRAM |

Install from the Ollama model menu (the backend builds `mcq-*` from the local
Modelfiles and pulls the base if missing) or from a shell:

```bash
bash training/mcq/setup.sh          # all three
bash training/mcq/setup.sh --lite   # skip Ultra (also --skip-ultra or MCQ_SKIP_ULTRA=1)
```

Model installs run as server-side jobs, so a page reload does not lose progress
and an install can be cancelled.

## Uncensored mode

The Uncensored toggle in the composer is off by default and is stored per chat.
When on, the chat switches to an installed uncensored local model if one exists
(the Uncensored group: Dolphin 3.0, Dolphin Llama 3, Dolphin Mistral, Dolphin
Mixtral, Wizard Vicuna Uncensored, Llama 2 Uncensored; or MCQ-Raw-8B), and a
directive at the top of the system prompt removes the app's content
restrictions. OpenClaw goes further: uncensored, no personal memory and no app
system prompt.
