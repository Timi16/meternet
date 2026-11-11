#!/usr/bin/env bash
# Builds the browser pages and copies them to the public server's web root
# (/srv/meternet/web, served by Caddy). Run install-caddy.sh once first.
#
#   deploy/server/sync-web.sh
#   SERVER=meternet@host SSH_KEY=~/.ssh/key deploy/server/sync-web.sh
set -euo pipefail

SERVER=${SERVER:-meternet@162.35.126.18}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/meternet}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

cd "$ROOT/web"
npm ci --silent --no-audit --no-fund
npm test --silent
npm run --silent build
rsync -az --delete -e "ssh -i $SSH_KEY -o ConnectTimeout=10" public/ "$SERVER:/srv/meternet/web/"
echo "web synced to $SERVER:/srv/meternet/web"
