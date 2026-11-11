#!/usr/bin/env bash
# Puts the public wss endpoint and the demo site in front of FNN (Ubuntu 24.04).
# Idempotent: safe to re-run, for example after changing HOST.
#
#   sudo HOST=162-35-126-18.sslip.io bash install-caddy.sh
#
# - Caddy from the Ubuntu archive, TLS certificates automatic (Let's Encrypt).
# - wss://fiber.$HOST -> FNN P2P port 8228 (WebSocket on the same port).
# - https://$HOST     -> /srv/meternet/web, cross-origin isolated for fiber-js.
# - Adds /dns4/fiber.$HOST/tcp/443/wss to FNN's announced_addrs and restarts it.
# Ports 80 and 443 must be open; 8227 (RPC) and 8228 (P2P) stay closed.
set -euo pipefail

HOST=${HOST:?set HOST, e.g. HOST=162-35-126-18.sslip.io}
HERE=$(cd "$(dirname "$0")" && pwd)
FNN_CONFIG=/var/lib/fnn/config.yml
WSS_ADDR="/dns4/fiber.${HOST}/tcp/443/wss"

command -v caddy >/dev/null || { apt-get update -qq && apt-get install -y -qq caddy; }
caddy version

# Web root; its content comes from deploy/server/sync-web.sh (runs as meternet).
install -d -m 755 -o meternet -g meternet /srv/meternet/web

sed "s/__HOST__/${HOST}/g" "$HERE/Caddyfile.template" > /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable --now caddy
systemctl reload caddy

# Announce the wss address (docs/fiber-node-wss.md, "Option A"). Drop any
# earlier wss line first so a HOST change leaves exactly one.
if ! grep -qF "\"${WSS_ADDR}\"" "$FNN_CONFIG"; then
  sed -i '/^    - "\/dns4\/.*\/tcp\/443\/wss"$/d' "$FNN_CONFIG"
  sed -i "/^  announced_addrs:\$/a\\    - \"${WSS_ADDR}\"" "$FNN_CONFIG"
  systemctl restart fnn
fi
grep -A1 '^  announced_addrs:' "$FNN_CONFIG"
echo "caddy: $(systemctl is-active caddy)  fnn: $(systemctl is-active fnn)"
