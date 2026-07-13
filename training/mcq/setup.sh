#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  MCQ Model Setup - Mirabilis AI
#  Registers MCQ-Pro-12B, MCQ-Ultra-31B, and MCQ-Raw-8B into your local Ollama instance.
#  Run once. Re-run anytime to rebuild after editing a Modelfile.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SKIP_ULTRA=0

for arg in "$@"; do
  case "$arg" in
    --skip-ultra|--lite)
      SKIP_ULTRA=1
      ;;
    -h|--help)
      cat <<'EOF'
Usage: bash training/mcq/setup.sh [--skip-ultra|--lite]

Options:
  --skip-ultra, --lite   Skip MCQ-Ultra-31B (large download / memory heavy)

Environment:
  MCQ_SKIP_ULTRA=1       Same as --skip-ultra
EOF
      exit 0
      ;;
  esac
done

if [[ "${MCQ_SKIP_ULTRA:-0}" == "1" ]]; then
  SKIP_ULTRA=1
fi

# ── Verify Ollama is running ──────────────────────────────────────────────────
if ! command -v ollama >/dev/null 2>&1; then
  echo "✗  Ollama CLI not found. Install from https://ollama.com/download"
  exit 1
fi

if ! ollama list &>/dev/null; then
  echo "✗  Ollama is not running. Start it with: ollama serve"
  exit 1
fi

ensure_base_model() {
  local base=$1
  if ollama show "$base" >/dev/null 2>&1; then
    return 0
  fi
  echo "  │  Base model missing. Pulling: $base"
  if ! ollama pull "$base"; then
    echo "  ✗  Failed to pull base model: $base"
    echo "     Check internet, disk space, and model availability in Ollama registry."
    return 1
  fi
}

# ── Build a model from a Modelfile ───────────────────────────────────────────
create() {
  local name=$1 file=$2 base=$3 size=$4
  echo ""
  echo "  ┌─ $name"
  echo "  │  Base : $base  ($size)"
  printf "  │  Status : "

  if ! ensure_base_model "$base"; then
    printf "FAILED\n"
    exit 1
  fi

  local out
  if out=$(ollama create "$name" -f "$DIR/$file" 2>&1); then
    echo "ready"
  else
    echo "FAILED"
    echo ""
    echo "$out"
    echo ""
    echo "  ✗  Could not create $name. Is the base model pulled? Try:"
    echo "     ollama pull $base"
    exit 1
  fi
  echo "  └─ done"
}

echo ""
echo "  MCQ Model Setup - Mirabilis AI"
echo "  ═════════════════════════════════"

create "mcq-pro-12b"   "Modelfile.mcq-pro-12b"   "gemma3:12b"      "8.1 GB"

if [[ "$SKIP_ULTRA" -eq 1 ]]; then
  echo ""
  echo "  ┌─ mcq-ultra-31b"
  echo "  │  Base : gemma4:31b (~20 GB)"
  echo "  │  Status : skipped (--skip-ultra/--lite)"
  echo "  └─ done"
else
  create "mcq-ultra-31b" "Modelfile.mcq-ultra-31b" "gemma4:31b"      "~20 GB"
fi

create "mcq-raw-8b"    "Modelfile.mcq-raw-8b"    "dolphin3:latest"  "4.9 GB"

echo ""
if [[ "$SKIP_ULTRA" -eq 1 ]]; then
  echo "  ✓  MCQ-Pro-12B and MCQ-Raw-8B are registered."
  echo "  ✓  To add Ultra later: bash training/mcq/setup.sh"
else
  echo "  ✓  All three MCQ models are registered."
fi
echo "  ✓  Restart Mirabilis to see them in the model selector under 'MCQ'."
echo ""
