#!/usr/bin/env bash
# Copies meterd to the public server, installs exact dependencies and runs the
# tests there. Never copies .env, logs or node_modules.
#
#   deploy/server/sync-meterd.sh            # defaults below
#   SERVER=ubuntu@host SSH_KEY=~/.ssh/key deploy/server/sync-meterd.sh
set -euo pipefail

SERVER=${SERVER:-ubuntu@16.192.4.91}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/meternet}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SSH=(ssh -i "$SSH_KEY" -o ConnectTimeout=10)

"${SSH[@]}" "$SERVER" 'mkdir -p ~/meternet/meterd ~/meternet/logs'
rsync -az --delete -e "ssh -i $SSH_KEY -o ConnectTimeout=10" \
  --exclude node_modules --exclude .env --exclude 'logs/' \
  "$ROOT/meterd/" "$SERVER:meternet/meterd/"
"${SSH[@]}" "$SERVER" 'set -e
  cd ~/meternet/meterd
  npm ci --silent --no-audit --no-fund
  npm test 2>&1 | grep -E "Tests|FAIL"
  npx tsc --noEmit && echo "typecheck ok"
  echo "fnn: $(systemctl is-active fnn)"'
