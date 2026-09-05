#!/usr/bin/env bash
# build.sh - Build Mirabilis AI.app
# Run from:  Mirabilis/desktop/
# Output:    Mirabilis/desktop/dist/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIRABILIS="$SCRIPT_DIR/.."
BUILD_TARGET="${1:-dir}"

case "$BUILD_TARGET" in
  dir)
    # An unpacked build for smoke-testing. Verify against the HOST platform:
    # hardcoding "mac" here made `./build.sh dir` fail on Linux, because
    # verify-release.js went looking for a .app bundle that cannot exist there.
    ELECTRON_BUILDER_ARGS=(--dir)
    case "$(uname -s)" in
      Darwin) VERIFY_TARGET="mac" ;;
      Linux)  VERIFY_TARGET="linux" ;;
      *)      VERIFY_TARGET="mac" ;;
    esac
    ;;
  dmg)
    # Both targets, deliberately. The dmg is for a first install by hand; the
    # zip is the only thing Squirrel.Mac can install an update from, so a
    # dmg-only build ships an app that can never update itself. Naming targets
    # here overrides build.mac.target in package.json, so this list has to stay
    # in step with it.
    ELECTRON_BUILDER_ARGS=(--mac dmg zip --arm64)
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

# Temp staging dir - auto-cleaned on exit (success, failure, or Ctrl+C)
BUILD_DIR="$(mktemp -d)"
trap 'echo "==> Cleaning up temp files..."; rm -rf "$BUILD_DIR"; echo "Done."' EXIT

echo "==> Staging build in $BUILD_DIR"

# Copy Electron entry files into staging root
cp "$SCRIPT_DIR/main.js"    "$BUILD_DIR/main.js"
cp "$SCRIPT_DIR/preload.js" "$BUILD_DIR/preload.js"
cp -r "$SCRIPT_DIR/icons"   "$BUILD_DIR/icons"
cp "$SCRIPT_DIR/package.json" "$BUILD_DIR/package.json"
cp "$SCRIPT_DIR/updater.js"   "$BUILD_DIR/updater.js"
cp "$SCRIPT_DIR/updatePolicy.js" "$BUILD_DIR/updatePolicy.js"
# The lockfile ships too. electron-updater is a RUNTIME dependency now: it is
# the code that decides which binary replaces the app, so its dependency tree
# should be the reviewed one, not whatever npm resolved on build day.
# NB: an `[ -f x ] && cp` one-liner would abort the whole build under
# `set -e` whenever the lockfile is absent, because the failed test is the
# statement's exit status. Use a real conditional.
if [ -f "$SCRIPT_DIR/package-lock.json" ]; then
  cp "$SCRIPT_DIR/package-lock.json" "$BUILD_DIR/package-lock.json"
fi

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

echo "==> Cleaning previous Next.js build output..."
rm -rf "$MIRABILIS/frontend/.next"

echo "==> Building Next.js frontend (standalone)..."
npm run build

echo "==> Syncing backend into staging..."
rsync -a "$MIRABILIS/backend/" "$BUILD_DIR/backend/" \
  --exclude node_modules --exclude .git

echo "==> Installing backend production deps..."
cd "$BUILD_DIR/backend" && npm install --omit=dev --silent

echo "==> Syncing standalone frontend into staging..."
# Create the full destination path first: old rsync (2.6.9, shipped on macOS
# CI runners) does not create intermediate parent directories, so rsyncing into
# .../frontend/.next/standalone/ fails unless .../frontend/.next/ already exists.
mkdir -p "$BUILD_DIR/frontend/.next/standalone"
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
# --publish never: the release workflow uploads the artifacts itself, in one
# place, after verifying them. electron-builder publishing on its own would be a
# second, unverified path to the same release.
npx electron-builder "${ELECTRON_BUILDER_ARGS[@]}" --publish never --projectDir "$BUILD_DIR"

echo "==> Copying output to dist/..."
mkdir -p "$SCRIPT_DIR/dist"
rsync -a --delete "$BUILD_DIR/dist/" "$SCRIPT_DIR/dist/"

echo "==> Verifying release artifacts..."
node "$SCRIPT_DIR/verify-release.js" "$VERIFY_TARGET"

echo ""
echo "Build complete!"
find "$SCRIPT_DIR/dist" -name "*.app" -maxdepth 3 | head -1

# trap fires here → cleans up $BUILD_DIR
