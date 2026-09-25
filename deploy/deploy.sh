#!/usr/bin/env bash
# Copies the app to gen22 (no rsync on the box) and restarts it. Usage: deploy/deploy.sh
set -euo pipefail
HOST=${HOST:-node@69.197.165.120}
PORT=${SSH_PORT:-22001}
KEY=${KEY:-~/.ssh/ai}
DEST=${DEST:-/workspace/video-compare}
SSH="ssh -i $KEY -o IdentitiesOnly=yes -p $PORT $HOST"

cd "$(dirname "$0")/.."
tar czf - package.json package-lock.json src public docs workflows deploy README.md .env.example \
  | $SSH "mkdir -p $DEST && tar xzf - -C $DEST"
$SSH "cd $DEST && [ -f .env ] || cp .env.example .env; npm install --omit=dev --silent; \
  if systemctl list-unit-files | grep -q video-compare.service; then sudo systemctl restart video-compare; \
  else pkill -f 'node src/server.js' || true; nohup node src/server.js > server.log 2>&1 & fi"
echo "deployed to $HOST:$DEST"
