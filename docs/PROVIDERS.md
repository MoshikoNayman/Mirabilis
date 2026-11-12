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

| Provider | Base URL | Free tier | Key format | Fallback model |
|---|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | No | `sk-...` | `gpt-6-luna` |
| Claude (Anthropic) | `https://api.anthropic.com` | No | `sk-ant-...` | `claude-haiku-5-5` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | Yes | `AIza...` | `gemini-3.5-flash-lite` |
| Grok (xAI) | `https://api.x.ai/v1` | No | `xai-...` | `grok-4.3` |
| Groq | `https://api.groq.com/openai/v1` | Yes | `gsk_...` | `openai/gpt-oss-20b` |
| OpenRouter | `https://openrouter.ai/api/v1` | Yes | `sk-or-...` | `openrouter/free` |
| Cerebras | `https://api.cerebras.ai/v1` | Yes | `csk-...` | `gpt-oss-120b` |
| GPUaaS Endpoint | your URL | Varies | provider specific | none |

GPUaaS Endpoint is for any OpenAI-compatible GPU host: Together AI, Fireworks,
RunPod, a vLLM gateway. Claude uses a native Anthropic adapter; the rest use the
OpenAI-compatible transport.

Cloud model lists come live from each provider. When a listing fails (no key,
offline, provider down) the fallback model from `providerDefaults` in
`backend/models.json` is used.

Request parameters follow the model family:

- Claude 5 and later (`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`,
  `claude-fable-5-2`) answer 400 to `temperature`, `top_p`, `top_k` and an
  assistant prefill, so none are sent. The rule reads the major version, so a
  Claude 6 needs no change. Older Claude models keep them.
- OpenAI's GPT-5, GPT-6 and o-series models get `max_completion_tokens` instead
  of `max_tokens`, and `temperature` and `top_p` only with `reasoning_effort`
  `"none"`. This applies on `api.openai.com` only; Groq, Cerebras, OpenRouter
  and local servers keep `max_tokens` and sampling.

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
Lanes follow the catalog groups, in catalog order:

| Lane | Takes |
|---|---|
| coding | Coding |
| reasoning | Reasoning, then any model with the thinking capability |
| general | Small & Fast, then Powerful |
| experimental | Uncensored, then models flagged `"uncensored": true` |

Another tag of a catalog model, such as `qwen3.8:27b-mlx`, takes that row's
group and flags. A model the catalog does not know goes by its name: `code`,
`reason` or `think` pick a lane, and `uncensored`, `abliterated`, `heretic` or
`dolphin` mark it uncensored. Embedding models are never picked, and other
lanes skip uncensored models while anything else is installed. Context size,
`low_vram` and thread counts are tuned to the device.

The Inference Cockpit under the model menu sets temperature, top-p, top-k, repeat
penalty, context window, GPU layers and a fixed seed for local Ollama models.

## Model catalog

The suggested-model list comes from three `models.json` files:

1. `backend/models.json`, bundled
2. the copy on the repository's main branch, fetched at most hourly
   (`MIRABILIS_CATALOG_URL`). When its `updated` date is the same as the
   bundle's or later, it replaces the bundled list, so a pick removed on main
   leaves every install without a release. An older copy is ignored, so a newer
   app keeps its own list.
3. `~/.mirabilis/models.json`, your own additions; they add and override by id
   (`MIRABILIS_USER_CATALOG`)

Go Dark blocks the remote fetch; the bundled list covers offline use.
`scripts/validate-model-catalog.mjs` runs on every push of the file and checks
the date, a minimum size and the groups Auto and the router read.

The catalog drives the picker groups, Auto, the router lanes and the uncensored
pick, so updating the file changes them with no app release. A row counts as
installed only when its exact tag is; a bare id means `:latest`. Every other
installed tag, such as `qwen3.8:27b-mlx`, is listed under Installed locally.
Rows marked `"local": true` are built on this machine and skipped by
`scripts/check-model-catalog.mjs`.

## MCQ models

MCQ is a model family by Moshiko Nayman, built from public base models with
Mirabilis-specific Modelfiles in `training/mcq/`.

| Model | Base | Size | Context | Use |
|---|---|---|---|---|
| MCQ-Raw-8B | `dolphin3` (Llama 3.1) | 4.9 GB | 8192 | Fast, fully unrestricted, no safety filters |
| MCQ-Pro-12B | `gemma3:12b` | 8.2 GB | 32768 | Everyday model |
| MCQ-Ultra-31B | `gemma4:31b` | 19-20 GB | 65536 | Highest quality; needs about 20 GB RAM/VRAM |

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
(the first installed model of the catalog's Uncensored group, else MCQ-Raw-8B
or another model flagged uncensored),
and a directive at the top of the system prompt removes the app's content
restrictions. OpenClaw goes further: uncensored, no personal memory and no app
system prompt.
