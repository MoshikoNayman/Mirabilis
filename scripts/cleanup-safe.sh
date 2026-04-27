#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=1
WITH_HEAVY_CACHE=0
WITH_VENV=0
WITH_NODE_MODULES=0
WITH_RUNTIME_DATA=0

usage() {
  cat <<'EOF'
Safe cleanup utility for Mirabilis workspace.

Default mode is dry-run (no files are deleted).

Usage:
  scripts/cleanup-safe.sh [options]

Options:
  --apply                 Actually delete files (default is preview only)
  --with-heavy-cache      Also remove image-service/.cache
  --with-venv             Also remove image-service/.venv and venv folders
  --with-node-modules     Also remove frontend/node_modules and backend/node_modules
  --with-runtime-data     Also remove runtime artifact data folders (uploads/intelledger-media)
  --help                  Show this help

Safe defaults remove only generated artifacts/logs:
  - frontend/.next
  - frontend/playwright-report
  - frontend/test-results
  - frontend/.turbo
  - Python cache dirs (__pycache__, .pytest_cache, .mypy_cache)
  - *.log files in the repo (excluding node_modules/.git/.venv)

Never removed unless explicitly requested:
  - backend/data/intelledger.json
  - backend/data/chats.json
  - backend/data/personal-memory.json
  - backend/data/mcp-servers.json
EOF
}

log() {
  printf '%s\n' "$*"
}

delete_path() {
  local path="$1"
  if [[ ! -e "$path" ]]; then
    return
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] rm -rf $path"
  else
    rm -rf "$path"
    log "[deleted] $path"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      DRY_RUN=0
      shift
      ;;
    --with-heavy-cache)
      WITH_HEAVY_CACHE=1
      shift
      ;;
    --with-venv)
      WITH_VENV=1
      shift
      ;;
    --with-node-modules)
      WITH_NODE_MODULES=1
      shift
      ;;
    --with-runtime-data)
      WITH_RUNTIME_DATA=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      log "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

log "Mirabilis safe cleanup"
log "Root: $ROOT_DIR"
if [[ "$DRY_RUN" -eq 1 ]]; then
  log "Mode: dry-run (preview only)"
else
  log "Mode: APPLY (deleting files)"
fi

# Safe generated artifacts
SAFE_DIRS=(
  "$ROOT_DIR/frontend/.next"
  "$ROOT_DIR/frontend/playwright-report"
  "$ROOT_DIR/frontend/test-results"
  "$ROOT_DIR/frontend/.turbo"
)

for d in "${SAFE_DIRS[@]}"; do
  delete_path "$d"
done

# Python cache directories in repo (excluding virtualenvs and node_modules)
while IFS= read -r cache_dir; do
  delete_path "$cache_dir"
done < <(
  find "$ROOT_DIR" \
    -type d \( -name '__pycache__' -o -name '.pytest_cache' -o -name '.mypy_cache' \) \
    -not -path '*/.git/*' \
    -not -path '*/node_modules/*' \
    -not -path '*/.venv/*' \
    -not -path '*/venv/*'
)

# Log files in repo (safe to delete)
while IFS= read -r log_file; do
  delete_path "$log_file"
done < <(
  find "$ROOT_DIR" \
    -type f -name '*.log' \
    -not -path '*/.git/*' \
    -not -path '*/node_modules/*' \
    -not -path '*/.venv/*' \
    -not -path '*/venv/*'
)

if [[ "$WITH_HEAVY_CACHE" -eq 1 ]]; then
  delete_path "$ROOT_DIR/image-service/.cache"
fi

if [[ "$WITH_VENV" -eq 1 ]]; then
  delete_path "$ROOT_DIR/image-service/.venv"
  delete_path "$ROOT_DIR/image-service/venv"
fi

if [[ "$WITH_NODE_MODULES" -eq 1 ]]; then
  delete_path "$ROOT_DIR/frontend/node_modules"
  delete_path "$ROOT_DIR/backend/node_modules"
fi

if [[ "$WITH_RUNTIME_DATA" -eq 1 ]]; then
  delete_path "$ROOT_DIR/backend/data/uploads"
  delete_path "$ROOT_DIR/backend/data/intelledger-media"
fi

log "Cleanup scan complete."
if [[ "$DRY_RUN" -eq 1 ]]; then
  log "Re-run with --apply to execute deletions."
fi
