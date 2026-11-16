#!/usr/bin/env bash
# First start: a fresh testnet key and wallet password in /data (kept on the
# box, never in git), and the release's testnet config with the box's
# browser-facing address announced: /dns4/$BOX_FQDN/tcp/8443/wss, which the
# box's Caddy terminates and forwards to FNN's P2P port 8228 (WebSocket on the
# same port, as on the public server). RPC stays on 127.0.0.1:8227.
set -euo pipefail
: "${BOX_FQDN:?set BOX_FQDN in box/.env: the DuckDNS name of the box}"

DATA=/data
install -d -m 700 "$DATA" "$DATA/ckb"
[ -n "$(ls -A "$DATA/ckb")" ] || (umask 077 && openssl rand -hex 32 > "$DATA/ckb/key")
[ -f "$DATA/password" ] || (umask 077 && openssl rand -hex 24 > "$DATA/password")
[ -f "$DATA/config.yml" ] || install -m 600 /opt/fnn/testnet-config.yml "$DATA/config.yml"

# Exactly one wss address: the box's (same edit as deploy/server/install-caddy.sh).
wss="/dns4/${BOX_FQDN}/tcp/8443/wss"
if ! grep -qF "\"${wss}\"" "$DATA/config.yml"; then
  sed -i '/^    - "\/dns4\/.*\/wss"$/d' "$DATA/config.yml"
  sed -i "/^  announced_addrs:\$/a\\    - \"${wss}\"" "$DATA/config.yml"
fi
grep -qF "\"${wss}\"" "$DATA/config.yml" || { echo "fnn: couldn't add ${wss} to announced_addrs" >&2; exit 1; }

export FIBER_SECRET_KEY_PASSWORD="$(cat "$DATA/password")"
exec fnn -c "$DATA/config.yml" -d "$DATA"
