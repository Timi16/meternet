#!/usr/bin/env bash
# The simulated phone's wallet: a second FNN on the test machine, standing in
# for the phone's browser node. Its RPC listens on the hotspot address
# (10.42.0.1:8237), so the phone reaches it through the box like a local app,
# and it opens a one-way channel to the box's FNN (127.0.0.1:8228).
#
#   sudo box/sim/payer.sh start     # (re)start it; prints its CKB address
#   sudo box/sim/payer.sh stop
# Data in /var/lib/fnn-payer (testnet key generated on first start).
set -euo pipefail

DATA=/var/lib/fnn-payer
BOX_CONFIG=/var/lib/fnn/config.yml

start() {
  install -d -m 700 "$DATA" "$DATA/ckb"
  [ -n "$(ls -A "$DATA/ckb")" ] || (umask 077 && openssl rand -hex 32 > "$DATA/ckb/key")
  [ -f "$DATA/password" ] || (umask 077 && openssl rand -hex 24 > "$DATA/password")
  # The box's testnet config, with this node's own ports and no announcements.
  sed -e 's#listening_addr: "/ip4/0.0.0.0/tcp/8228"#listening_addr: "/ip4/127.0.0.1/tcp/8238"#' \
      -e 's#listening_addr: "127.0.0.1:8227"#listening_addr: "10.42.0.1:8237"#' \
      -e 's#^  announce_listening_addr: true#  announce_listening_addr: false#' \
      -e '/^    - "\/dns4\/.*\/wss"$/d' \
      "$BOX_CONFIG" > "$DATA/config.yml"
  systemctl stop meternet-sim-payer 2>/dev/null || true
  systemd-run --quiet --unit meternet-sim-payer --working-directory="$DATA" \
    /bin/sh -c "FIBER_SECRET_KEY_PASSWORD=\"\$(cat $DATA/password)\" exec /usr/local/bin/fnn -c $DATA/config.yml -d $DATA"
  for _ in $(seq 1 30); do
    if curl -fs -X POST http://10.42.0.1:8237 -H 'content-type: application/json' \
         -d '{"id":1,"jsonrpc":"2.0","method":"node_info","params":[]}' >/dev/null; then
      echo "payer FNN is up on 10.42.0.1:8237"; return 0
    fi
    sleep 1
  done
  echo "payer FNN did not start; see: journalctl -u meternet-sim-payer" >&2
  return 1
}

case "${1:-}" in
  start) start ;;
  stop) systemctl stop meternet-sim-payer 2>/dev/null || true; echo "payer stopped" ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
