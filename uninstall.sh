#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$ROOT_DIR"

read -r -p "Remove Mirabilis files and caches? (yes/no): " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Cancelled."
  exit 0
fi

if command -v ollama >/dev/null 2>&1; then
  for model in llama3 mistral; do
    if ollama list | awk '{print $1}' | grep -q "^${model}"; then
      echo "Removing Ollama model: $model"
      ollama rm "$model" || true
    fi
  done
fi

rm -rf "$APP_DIR/backend/node_modules"
rm -rf "$APP_DIR/frontend/node_modules"
rm -f "$APP_DIR/backend/data/chats.json"
rm -f "$APP_DIR/backend/.env"
rm -f "$APP_DIR/frontend/.env.local"

echo "Removing project directory: $APP_DIR"
cd "$(dirname "$APP_DIR")"
rm -rf "$APP_DIR"

echo "Uninstall complete."
