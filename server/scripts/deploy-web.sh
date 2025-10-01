#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEBAPP_DIR="/home/projects/brewski/webapp"
BUILD_DIR="/home/projects/brewski/webapp/web-build"
DEST_DIR="/home/projects/brewski/server/public"   # CHANGE THIS if your server expects a different path

echo "=> Building web export..."
cd "$WEBAPP_DIR"
npm run web:build

echo "=> Syncing to $DEST_DIR"
mkdir -p "$DEST_DIR"
rsync -av --delete "$BUILD_DIR/" "$DEST_DIR/"

echo "=> Done. Restart your server to pick up changes (if it doesn’t watch the dir)."