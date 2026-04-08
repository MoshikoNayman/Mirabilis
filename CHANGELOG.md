# Mirabilis AI — Changelog

Versioning follows Junos-style tags.

## [26.2R1] — 2026-04-06

### Launcher and Naming Cleanup

- Replaced fragmented startup scripts with a unified launcher:
  - `install.sh`
  - `run.sh`
- Added canonical provider names across launcher, backend, and UI:
  - `ollama`
  - `openai-compatible`
  - `koboldcpp`
- Removed legacy alias behavior from `run.sh` so provider naming is consistent.

### Provider Runtime Reliability

- `install.sh` now installs and validates local runtime binaries:
  - `llama-server`
  - `koboldcpp`
- KoboldCpp installer now fetches the latest release asset from GitHub and validates binary format.
- `run.sh` now supports explicit provider modes:
  - `./run.sh ollama`
  - `./run.sh openai-compatible`
  - `./run.sh koboldcpp`
- `./run.sh` (UI mode) starts all available local providers so switching in UI does not require relaunching.

### CPU Core Utilization

- Added automatic thread detection using all logical CPU cores by default for:
  - `llama-server`
  - `koboldcpp`
- Added override env var:
  - `MIRABILIS_THREADS=<n>`
- Applied thread flags:
  - `llama-server`: `--threads`, `--threads-batch`, `--threads-http`
  - `koboldcpp`: `--threads`, `--blasthreads`

### Session Management

- Added `./run.sh stop` to cleanly terminate all Mirabilis/provider processes.

### Uncensored Mode Hardening

- Backend uncensored directive tightened to reduce refusals/moralizing on profanity-heavy prompts.
- Added guard to avoid policy/instruction leakage in uncensored responses.

### Config and Provider Defaults

- OpenAI-compatible default base URL updated to `http://127.0.0.1:8000/v1`.
- Provider-health fallback behavior improved so unreachable external providers can fall back to Ollama when available.

### Docs Refresh

- README rewritten to match current scripts and canonical provider modes.
- Removed stale references to deleted scripts (`run-local.sh`, `mirabilis-start.sh`, etc.).


