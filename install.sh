#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
IMAGE_SERVICE_DIR="$ROOT_DIR/image-service"
PROVIDERS_DIR="$ROOT_DIR/providers"

echo "🔧 Installing Mirabilis dependencies..."

# Check for Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Install from https://nodejs.org"
  exit 1
fi
echo "✅ Node.js: $(node -v)"

# Install backend
echo ""
echo "📦 Installing backend dependencies..."
cd "$BACKEND_DIR"
npm install --legacy-peer-deps

# Install frontend
echo ""
echo "📦 Installing frontend dependencies..."
cd "$FRONTEND_DIR"
npm install --legacy-peer-deps

# Setup Python environment for image service
echo ""
echo "🐍 Setting up Python environment..."
cd "$IMAGE_SERVICE_DIR"

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi

source .venv/bin/activate
pip install -q --upgrade pip
pip install -q -r requirements.txt
deactivate

# Provider runtimes
echo ""
echo "📥 Installing provider runtimes..."
mkdir -p "$PROVIDERS_DIR"

OS=$(uname -s)
ARCH=$(uname -m)

install_llama_server() {
  local llama_url
  if [[ "$ARCH" == "arm64" ]]; then
    llama_url="https://github.com/ggerganov/llama.cpp/releases/download/b3920/llama-b3920-bin-macos-arm64.zip"
  else
    llama_url="https://github.com/ggerganov/llama.cpp/releases/download/b3920/llama-b3920-bin-macos-x64.zip"
  fi

  if [[ -x "$PROVIDERS_DIR/llama-server" ]]; then
    echo "✅ llama-server already exists"
    return 0
  fi

  local zip_path="$PROVIDERS_DIR/llama.zip"
  curl -fL "$llama_url" -o "$zip_path"
  unzip -qo "$zip_path" -d "$PROVIDERS_DIR"
  rm -f "$zip_path"

  if [[ -f "$PROVIDERS_DIR/build/bin/llama-server" ]]; then
    mv "$PROVIDERS_DIR/build/bin/llama-server" "$PROVIDERS_DIR/llama-server"
  fi
  if [[ -f "$PROVIDERS_DIR/build/bin/llama-cli" ]]; then
    mv "$PROVIDERS_DIR/build/bin/llama-cli" "$PROVIDERS_DIR/llama-cli"
  fi
  rm -rf "$PROVIDERS_DIR/build"

  chmod +x "$PROVIDERS_DIR/llama-server" "$PROVIDERS_DIR/llama-cli" 2>/dev/null || true
  if ! file "$PROVIDERS_DIR/llama-server" | grep -q 'Mach-O'; then
    echo "❌ llama-server install failed (invalid binary)."
    return 1
  fi
  echo "✅ llama-server installed"
}

install_koboldcpp() {
  if [[ -x "$PROVIDERS_DIR/koboldcpp" ]] && file "$PROVIDERS_DIR/koboldcpp" | grep -q 'Mach-O'; then
    echo "✅ koboldcpp already exists"
    return 0
  fi

  local asset_name
  if [[ "$ARCH" == "arm64" ]]; then
    asset_name="koboldcpp-mac-arm64"
  else
    echo "❌ KoboldCpp auto-install currently supports macOS arm64 in this setup."
    return 1
  fi

  local kobold_url
  kobold_url="$(python3 - <<PY
import json, urllib.request
api='https://api.github.com/repos/LostRuins/koboldcpp/releases/latest'
with urllib.request.urlopen(api) as r:
    release=json.load(r)
for asset in release.get('assets', []):
    if asset.get('name') == '${asset_name}':
        print(asset.get('browser_download_url', ''))
        break
PY
)"

  if [[ -z "$kobold_url" ]]; then
    echo "❌ Could not resolve KoboldCpp release asset URL."
    return 1
  fi

  curl -fL "$kobold_url" -o "$PROVIDERS_DIR/koboldcpp"
  chmod +x "$PROVIDERS_DIR/koboldcpp"
  if ! file "$PROVIDERS_DIR/koboldcpp" | grep -q 'Mach-O'; then
    echo "❌ KoboldCpp install failed (invalid binary)."
    return 1
  fi
  echo "✅ koboldcpp installed"
}

if [[ "$OS" == "Darwin" ]]; then
  install_llama_server
  install_koboldcpp
else
  echo "⚠️  Non-macOS detected. Provider runtime auto-install skipped."
fi

echo ""
echo "✅ Installation complete!"
echo ""
echo "Next: ./run.sh [ui|ollama|openai-compatible|koboldcpp]"
