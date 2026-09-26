#!/usr/bin/env bash
# Copies the app to gen22 (no rsync on the box) and restarts it. Usage: deploy/deploy.sh
set -euo pipefail
HOST=${HOST:-node@69.197.165.120}
PORT=${SSH_PORT:-22001}
KEY=${KEY:-~/.ssh/ai}
DEST=${DEST:-/workspace/video-compare}
SSH="ssh -i $KEY -o IdentitiesOnly=yes -p $PORT $HOST"

cd "$(dirname "$0")/.."
COPYFILE_DISABLE=1 tar czf - package.json package-lock.json src public docs workflows deploy README.md .env.example \
  | $SSH "mkdir -p $DEST && tar xzf - -C $DEST"
$SSH "cd $DEST && [ -f .env ] || cp .env.example .env; npm install --omit=dev --silent; \
  pkill -f '^node src/server.js' || true; sleep 1; \
  (setsid nohup node src/server.js > server.log 2>&1 < /dev/null &); sleep 2; tail -2 server.log"
echo "deployed to $HOST:$DEST"
