#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  MSQ Model Setup — Mirabilis AI
#  Registers MSQ-Pro-12B, MSQ-Ultra-31B, and MSQ-Raw-8B into your local Ollama instance.
#  Run once. Re-run anytime to rebuild after editing a Modelfile.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Verify Ollama is running ──────────────────────────────────────────────────
if ! ollama list &>/dev/null; then
  echo "✗  Ollama is not running. Start it with: ollama serve"
  exit 1
fi

# ── Build a model from a Modelfile ───────────────────────────────────────────
create() {
  local name=$1 file=$2 base=$3 size=$4
  echo ""
  echo "  ┌─ $name"
  echo "  │  Base : $base  ($size)"
  printf "  │  Status : "
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
echo "  MSQ Model Setup — Mirabilis AI"
echo "  ═════════════════════════════════"

create "msq-pro-12b"   "Modelfile.msq-pro-12b"   "gemma3:12b"      "8.1 GB"
create "msq-ultra-31b" "Modelfile.msq-ultra-31b" "gemma4:31b"      "~20 GB"
create "msq-raw-8b"    "Modelfile.msq-raw-8b"    "dolphin3:latest"  "4.9 GB"

echo ""
echo "  ✓  All three MSQ models are registered."
echo "  ✓  Restart Mirabilis to see them in the model selector under 'MSQ'."
echo ""
