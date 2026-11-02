#!/usr/bin/env bash
# Copies the app to gen22 (no rsync on the box) and (re)starts it in a detached tmux session
# with a restart loop (attach with: tmux attach -t video-compare). Usage: deploy/deploy.sh
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
  tmux kill-session -t video-compare 2>/dev/null; pkill -f '^node src/server.js' || true; sleep 1; \
  tmux new -d -s video-compare 'cd $DEST && while true; do echo \"[supervisor] start \$(date -Is)\" >> server.log; node src/server.js >> server.log 2>&1; echo \"[supervisor] exited \$? at \$(date -Is)\" >> server.log; sleep 3; done'; \
  sleep 3; tail -2 server.log"
echo "deployed to $HOST:$DEST"
