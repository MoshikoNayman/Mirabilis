#!/usr/bin/env bash
# build.sh — Build Mirabilis AI.app
# Run from:  Mirabilis/desktop/
# Output:    Mirabilis/desktop/dist/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIRABILIS="$SCRIPT_DIR/.."
BUILD_TARGET="${1:-dir}"

case "$BUILD_TARGET" in
  dir)
    ELECTRON_BUILDER_ARGS=(--dir)
    VERIFY_TARGET="mac"
    ;;
  dmg)
    ELECTRON_BUILDER_ARGS=(--mac dmg --arm64)
    VERIFY_TARGET="mac"
    ;;
  appimage)
    ELECTRON_BUILDER_ARGS=(--linux AppImage --x64)
    VERIFY_TARGET="linux"
    ;;
  *)
    echo "Unsupported build target: $BUILD_TARGET"
    echo "Usage: ./build.sh [dir|dmg|appimage]"
    exit 1
    ;;
esac

# Temp staging dir — auto-cleaned on exit (success, failure, or Ctrl+C)
BUILD_DIR="$(mktemp -d)"
trap 'echo "==> Cleaning up temp files..."; rm -rf "$BUILD_DIR"; echo "Done."' EXIT

echo "==> Staging build in $BUILD_DIR"

# Copy Electron entry files into staging root
cp "$SCRIPT_DIR/main.js"    "$BUILD_DIR/main.js"
cp "$SCRIPT_DIR/preload.js" "$BUILD_DIR/preload.js"
cp -r "$SCRIPT_DIR/icons"   "$BUILD_DIR/icons"
cp "$SCRIPT_DIR/package.json" "$BUILD_DIR/package.json"

echo "==> Installing backend dependencies..."
cd "$MIRABILIS/backend"
if [ -f package-lock.json ]; then
  npm ci --silent || npm install --silent
else
  npm install --silent
fi

echo "==> Installing frontend dependencies..."
cd "$MIRABILIS/frontend"
if [ -f package-lock.json ]; then
  npm ci --silent || npm install --silent
else
  npm install --silent
fi

echo "==> Building Next.js frontend (standalone)..."
npm run build

echo "==> Syncing backend into staging..."
rsync -a "$MIRABILIS/backend/" "$BUILD_DIR/backend/" \
  --exclude node_modules --exclude .git

echo "==> Installing backend production deps..."
cd "$BUILD_DIR/backend" && npm install --omit=dev --silent

echo "==> Syncing standalone frontend into staging..."
rsync -a "$MIRABILIS/frontend/.next/standalone/" "$BUILD_DIR/frontend/.next/standalone/"

echo "==> Copying static assets..."
mkdir -p "$BUILD_DIR/frontend/.next/standalone/frontend/.next"
rsync -a "$MIRABILIS/frontend/.next/static/" \
  "$BUILD_DIR/frontend/.next/standalone/frontend/.next/static/"

if [ -d "$MIRABILIS/frontend/public" ]; then
  rsync -a "$MIRABILIS/frontend/public/" \
    "$BUILD_DIR/frontend/.next/standalone/frontend/public/"
fi

echo "==> Installing Electron build tools..."
cd "$BUILD_DIR"
if [ -f package-lock.json ]; then
  npm ci --silent || npm install --silent
else
  npm install --silent
fi

echo "==> Running electron-builder..."
npx electron-builder "${ELECTRON_BUILDER_ARGS[@]}" --projectDir "$BUILD_DIR"

echo "==> Copying output to dist/..."
rm -rf "$SCRIPT_DIR/dist"
cp -r "$BUILD_DIR/dist" "$SCRIPT_DIR/dist"

echo "==> Verifying release artifacts..."
node "$SCRIPT_DIR/verify-release.js" "$VERIFY_TARGET"

echo ""
echo "Build complete!"
find "$SCRIPT_DIR/dist" -name "*.app" -maxdepth 3 | head -1

# trap fires here → cleans up $BUILD_DIR
