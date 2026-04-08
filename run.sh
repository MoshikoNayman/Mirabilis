#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
IMAGE_SERVICE_DIR="$ROOT_DIR/image-service"
PROVIDERS_DIR="$ROOT_DIR/providers"
OLLAMA_STARTED_BY_SCRIPT=0
MODEL_PATH="/tmp/mirabilis-llama-3.2-1b-instruct-q4_k_m.gguf"

detect_thread_count() {
  if [[ -n "${MIRABILIS_THREADS:-}" ]]; then
    echo "$MIRABILIS_THREADS"
    return 0
  fi
  if command -v sysctl >/dev/null 2>&1; then
    local n
    n="$(sysctl -n hw.logicalcpu 2>/dev/null || true)"
    if [[ -n "$n" ]] && [[ "$n" -gt 0 ]] 2>/dev/null; then
      echo "$n"
      return 0
    fi
  fi
  if command -v getconf >/dev/null 2>&1; then
    local n
    n="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
    if [[ -n "$n" ]] && [[ "$n" -gt 0 ]] 2>/dev/null; then
      echo "$n"
      return 0
    fi
  fi
  echo 4
}

THREADS="$(detect_thread_count)"

# Parse arguments
PROVIDER="${1:-ui}"  # default: let user choose from UI

usage() {
  cat <<'EOF'
Usage: ./run.sh [provider]

Providers:
  ui                 - Start app and choose provider from UI (default)
  ollama             - Use Ollama provider
  openai-compatible  - Use llama-server as OpenAI-compatible provider
  koboldcpp          - Use KoboldCpp provider
  stop               - Stop all Mirabilis/provider processes

Environment:
  MIRABILIS_THREADS  - Override CPU threads for llama-server/koboldcpp (default: all logical cores)

Example:
  ./run.sh
  ./run.sh ollama
  ./run.sh openai-compatible
  ./run.sh koboldcpp
  ./run.sh stop

EOF
}

if [[ "$PROVIDER" == "-h" || "$PROVIDER" == "--help" ]]; then
  usage
  exit 0
fi

# Check if dependencies are installed
if [[ ! -d "$BACKEND_DIR/node_modules" ]] || [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  echo "❌ Dependencies not installed."
  echo "Run: ./install.sh"
  exit 1
fi

if [[ ! -d "$IMAGE_SERVICE_DIR/.venv" ]]; then
  echo "❌ Python environment not set up."
  echo "Run: ./install.sh"
  exit 1
fi

# Cleanup on exit
cleanup() {
  echo ""
  echo "🛑 Stopping Mirabilis..."
  [[ -n "${BACKEND_PID:-}" ]] && kill "$BACKEND_PID" 2>/dev/null || true
  [[ -n "${FRONTEND_PID:-}" ]] && kill "$FRONTEND_PID" 2>/dev/null || true
  [[ -n "${IMAGE_PID:-}" ]] && kill "$IMAGE_PID" 2>/dev/null || true
  if [[ -n "${LLAMA_PID:-}" ]]; then
    kill $LLAMA_PID 2>/dev/null || true
  fi
  if [[ -n "${KOBOLD_PID:-}" ]]; then
    kill $KOBOLD_PID 2>/dev/null || true
  fi
  if [[ "$OLLAMA_STARTED_BY_SCRIPT" -eq 1 ]] && [[ -n "${OLLAMA_PID:-}" ]]; then
    kill "$OLLAMA_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

normalize_provider() {
  local raw="$(echo "${1:-ui}" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    stop) echo "stop" ;;
    ui) echo "ui" ;;
    ollama) echo "ollama" ;;
    openai-compatible) echo "openai-compatible" ;;
    koboldcpp) echo "koboldcpp" ;;
    *) echo "" ;;
  esac
}

ensure_ollama_ready() {
  if curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v ollama >/dev/null 2>&1; then
    return 1
  fi

  echo "🚀 Starting Ollama service..."
  ollama serve > /tmp/ollama.log 2>&1 &
  OLLAMA_PID=$!
  OLLAMA_STARTED_BY_SCRIPT=1

  for _ in {1..20}; do
    if curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  return 1
}

ensure_ollama_model() {
  if ! command -v ollama >/dev/null 2>&1; then
    return 1
  fi

  local model_count
  model_count="$(curl -s http://127.0.0.1:11434/api/tags | grep -o '"name"' | wc -l | tr -d ' ')"
  if [[ "$model_count" -ge 1 ]]; then
    return 0
  fi

  echo "📥 No Ollama models found. Pulling qwen2.5:0.5b (one-time)..."
  ollama pull qwen2.5:0.5b
}

ensure_llama_model() {
  local model_path="$1"
  local model_url="https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf"

  local needs_download=0
  if [[ ! -f "$model_path" ]]; then
    needs_download=1
  else
    local magic
    magic="$(head -c 4 "$model_path" 2>/dev/null || true)"
    if [[ "$magic" != "GGUF" ]]; then
      needs_download=1
    fi
  fi

  if [[ "$needs_download" -eq 1 ]]; then
    echo "📥 Downloading llama model (one-time)..."
    curl -fL --retry 3 --connect-timeout 15 "$model_url" -o "$model_path"
  fi

  local final_magic
  final_magic="$(head -c 4 "$model_path" 2>/dev/null || true)"
  if [[ "$final_magic" != "GGUF" ]]; then
    echo "❌ Downloaded model is invalid (not GGUF)."
    return 1
  fi

  return 0
}

start_openai_compatible() {
  if [[ ! -x "$PROVIDERS_DIR/llama-server" ]]; then
    echo "❌ llama-server not found. Run: ./install.sh"
    return 1
  fi
  if ! ensure_llama_model "$MODEL_PATH"; then
    echo "❌ Unable to prepare a valid GGUF model for OpenAI-compatible provider."
    return 1
  fi

  echo "🚀 Starting llama-server (OpenAI-compatible, threads=$THREADS)..."
  "$PROVIDERS_DIR/llama-server" \
    -m "$MODEL_PATH" \
    -ngl 50 \
    --threads "$THREADS" \
    --threads-batch "$THREADS" \
    --threads-http "$THREADS" \
    --port 8000 > /tmp/llama.log 2>&1 &
  LLAMA_PID=$!

  for _ in {1..30}; do
    if curl -sS http://127.0.0.1:8000/v1/models >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "❌ OpenAI-compatible provider did not become ready at http://127.0.0.1:8000/v1/models"
  tail -40 /tmp/llama.log || true
  return 1
}

start_koboldcpp() {
  if [[ ! -x "$PROVIDERS_DIR/koboldcpp" ]]; then
    echo "❌ koboldcpp not found. Run: ./install.sh"
    return 1
  fi
  if ! file "$PROVIDERS_DIR/koboldcpp" | grep -q 'Mach-O'; then
    echo "❌ koboldcpp binary is invalid. Run: ./install.sh"
    return 1
  fi
  if ! ensure_llama_model "$MODEL_PATH"; then
    echo "❌ Unable to prepare a valid GGUF model for KoboldCpp provider."
    return 1
  fi

  echo "🚀 Starting KoboldCpp (threads=$THREADS)..."
  "$PROVIDERS_DIR/koboldcpp" \
    --model "$MODEL_PATH" \
    --host 127.0.0.1 \
    --port 5001 \
    --threads "$THREADS" \
    --blasthreads "$THREADS" \
    --quiet > /tmp/koboldcpp.log 2>&1 &
  KOBOLD_PID=$!

  for _ in {1..30}; do
    if curl -sS http://127.0.0.1:5001/v1/models >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "❌ KoboldCpp did not become ready at http://127.0.0.1:5001/v1/models"
  tail -40 /tmp/koboldcpp.log || true
  return 1
}

# Handle provider selection
AI_PROVIDER="ollama"  # default provider backend uses
PROVIDER="$(normalize_provider "$PROVIDER")"

if [[ -z "$PROVIDER" ]]; then
  echo "❌ Unknown provider. Use one of: ui, ollama, openai-compatible, koboldcpp, stop"
  usage
  exit 1
fi

if [[ "$PROVIDER" == "stop" ]]; then
  echo "🛑 Stopping Mirabilis and provider processes..."
  pkill -f "node --watch src/server.js|next dev|python server.py|llama-server|koboldcpp|ollama serve" >/dev/null 2>&1 || true
  echo "✅ Stopped"
  trap - EXIT INT TERM
  exit 0
fi

case "$PROVIDER" in
  ui)
    echo "🌐 Starting Mirabilis (choose provider from UI)"
    AI_PROVIDER="ollama"
    unset OPENAI_API_KEY KOBOLD_API_KEY || true
    if ! ensure_ollama_ready; then
      echo "❌ Ollama is not available and could not be started."
      echo "Install Ollama: brew install ollama"
      exit 1
    fi
    if ! ensure_ollama_model; then
      echo "❌ Could not ensure an Ollama model is available."
      exit 1
    fi

    OPENAI_READY=0
    KOBOLD_READY=0

    if [[ -x "$PROVIDERS_DIR/llama-server" ]]; then
      if start_openai_compatible; then
        export OPENAI_BASE_URL="http://127.0.0.1:8000/v1"
        OPENAI_READY=1
      fi
    fi

    if [[ -x "$PROVIDERS_DIR/koboldcpp" ]]; then
      if start_koboldcpp; then
        export KOBOLD_BASE_URL="http://127.0.0.1:5001/v1"
        KOBOLD_READY=1
      fi
    fi

    echo "Provider status: ollama=ready openai-compatible=$([[ "$OPENAI_READY" -eq 1 ]] && echo ready || echo unavailable) koboldcpp=$([[ "$KOBOLD_READY" -eq 1 ]] && echo ready || echo unavailable)"
    ;;
  ollama)
    echo "🚀 Using Ollama provider"
    AI_PROVIDER="ollama"
    unset OPENAI_BASE_URL OPENAI_API_KEY KOBOLD_BASE_URL KOBOLD_API_KEY || true
    if ! ensure_ollama_ready; then
      echo "❌ Ollama is not available and could not be started."
      echo "Install Ollama: brew install ollama"
      exit 1
    fi
    if ! ensure_ollama_model; then
      echo "❌ Could not ensure an Ollama model is available."
      exit 1
    fi
    ;;
  openai-compatible)
    echo "🚀 Using OpenAI-compatible provider"
    unset KOBOLD_BASE_URL KOBOLD_API_KEY || true
    if ! start_openai_compatible; then
      exit 1
    fi
    AI_PROVIDER="openai-compatible"
    export OPENAI_BASE_URL="http://127.0.0.1:8000/v1"
    ;;
  koboldcpp)
    echo "🚀 Using KoboldCpp provider"
    unset OPENAI_BASE_URL OPENAI_API_KEY || true
    if ! start_koboldcpp; then
      exit 1
    fi
    AI_PROVIDER="koboldcpp"
    export KOBOLD_BASE_URL="http://127.0.0.1:5001/v1"
    ;;
  *)
    echo "❌ Unknown provider: $PROVIDER"
    usage
    exit 1
    ;;
esac

# Start services
export AI_PROVIDER

echo ""
echo "📦 Starting services..."

# Backend
cd "$BACKEND_DIR"
export PORT=4000
npm run dev > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
sleep 2
echo "   Backend: http://127.0.0.1:4000"

# Frontend
cd "$FRONTEND_DIR"
export PORT=3000
npm run dev > /tmp/frontend.log 2>&1 &
FRONTEND_PID=$!
sleep 3
echo "   Frontend: http://127.0.0.1:3000"

# Image service
cd "$IMAGE_SERVICE_DIR"
export IMAGE_SERVICE_PORT=7860
source .venv/bin/activate
python server.py > /tmp/image-service.log 2>&1 &
IMAGE_PID=$!
deactivate
echo "   Image Service: http://127.0.0.1:7860"

sleep 2

echo ""
echo "✅ Mirabilis is running!"
echo "🌐 Open: http://localhost:3000"
echo "📝 Provider: $AI_PROVIDER"
if [[ "$PROVIDER" == "ui" ]]; then
  echo "   (Select any provider from the UI settings)"
fi
echo ""
echo "Press Ctrl+C to stop"
echo ""

# Wait for processes
wait $BACKEND_PID $FRONTEND_PID $IMAGE_PID 2>/dev/null || true
