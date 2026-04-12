#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required but was not found in PATH."
  echo "Install Node.js and retry."
  exit 1
fi

exec node "$ROOT_DIR/run.js" "$@"
