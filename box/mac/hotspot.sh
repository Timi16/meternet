#!/usr/bin/env bash
# MeterNet hotspot box on macOS: MeterNet's pf rules on top of macOS
# Internet Sharing (which provides the Wi-Fi access point, DHCP, DNS and
# NAT). Linux boxes use openNDS instead (box/linux).
#
#   sudo box/mac/hotspot.sh check    # changes nothing: reports what's ready
#   sudo box/mac/hotspot.sh up       # load the rules: phones are blocked until they pay
#   sudo box/mac/hotspot.sh status   # paid phones and the bytes each has used
#   sudo box/mac/hotspot.sh down     # remove the rules (Internet Sharing stays as you set it)
#
# Rules live in the pf anchor com.apple/meternet, which macOS's /etc/pf.conf
# already evaluates. No system file is edited, and `down` removes everything.
set -euo pipefail

ANCHOR=com.apple/meternet
IFACE=${IFACE:-bridge100}
# Extra hosts unpaid phones may reach on 443. Empty by default: the box
# proxies the CKB testnet RPC itself, because testnet.ckbapp.dev sits on
# shared Cloudflare addresses, and allowing those would open every other site
# behind them to phones that haven't paid.
WALLED_HOSTS=${WALLED_HOSTS:-}
HERE=$(cd "$(dirname "$0")" && pwd)
RULES=$HERE/pf.anchor
TOKEN_FILE=/var/run/meternet-pf.token

ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
need_root() { [ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo $0 $*" >&2; exit 1; }; }

box_ip() { ipconfig getifaddr "$IFACE" 2>/dev/null || true; }

walled_ips() {
  for h in $WALLED_HOSTS; do dig +short A "$h" | grep -E '^[0-9.]+$' || true; done | sort -u
}

load_rules() {
  pfctl -q -D "iface=$IFACE" -D "box=$1" -a "$ANCHOR" "$2" -f "$RULES"
}

internet_sharing_help() {
  cat <<'EOF'
     Turn on Internet Sharing:
       System Settings > General > Sharing > Internet Sharing (click the i)
       - Share your connection from: your phone over USB (iPhone USB, or
         Android USB tethering) or Ethernet. Not Wi-Fi: Wi-Fi becomes the hotspot.
       - To devices using: Wi-Fi. Wi-Fi Options: Network Name "MeterNet-demo".
       Then switch Internet Sharing on and run this check again.
EOF
}

cmd_check() {
  need_root check
  local ip uplink failed=0
  echo "MeterNet hotspot check (macOS)"
  ip=$(box_ip)
  if [ -n "$ip" ]; then ok "Internet Sharing is on: $IFACE has $ip"; else bad "Internet Sharing is off ($IFACE has no address)"; internet_sharing_help; failed=1; fi
  uplink=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
  if [ -n "$uplink" ] && [ "$uplink" != "en0" ]; then ok "uplink is $uplink (not Wi-Fi)"; else bad "uplink is ${uplink:-missing}: it must not be Wi-Fi (en0), which is the hotspot"; failed=1; fi
  if load_rules "${ip:-192.168.2.1}" -n; then ok "MeterNet's pf rules parse"; else bad "pf rejected box/mac/pf.anchor"; failed=1; fi
  if [ -n "$WALLED_HOSTS" ]; then
    local w; w=$(walled_ips | tr '\n' ' ')
    if [ -n "$w" ]; then ok "extra walled-garden hosts: $WALLED_HOSTS -> $w"; else bad "could not resolve $WALLED_HOSTS"; failed=1; fi
  else
    ok "walled garden: the box only (the CKB RPC is proxied through it)"
  fi
  if pfctl -s info 2>/dev/null | grep -q "Status: Enabled"; then ok "pf is enabled"; else echo "  - pf is not enabled yet (up enables it)"; fi
  echo
  echo "Rule order (for MeterNet's developer: where com.apple/meternet sits"
  echo "relative to Internet Sharing's own rules):"
  pfctl -s Anchors -v 2>/dev/null | sed 's/^/    /' || true
  pfctl -a com.apple/internet-sharing -s rules 2>/dev/null | sed 's/^/    internet-sharing: /' || true
  pfctl -a com.apple.internet-sharing -s rules 2>/dev/null | sed 's/^/    internet-sharing: /' || true
  [ "$failed" -eq 0 ] && echo "Ready: run 'sudo $0 up'." || { echo "Fix the ✗ items above, then run check again."; exit 1; }
}

cmd_up() {
  need_root up
  local ip; ip=$(box_ip)
  [ -n "$ip" ] || { echo "Internet Sharing is off." >&2; internet_sharing_help; exit 1; }
  load_rules "$ip" ""
  # shellcheck disable=SC2046
  [ -z "$WALLED_HOSTS" ] || pfctl -q -a "$ANCHOR" -t walled -T replace $(walled_ips)
  if [ ! -s "$TOKEN_FILE" ]; then
    pfctl -E 2>&1 | awk '/Token/{print $NF}' > "$TOKEN_FILE"
  fi
  echo "MeterNet rules are up on $IFACE ($ip). Phones are blocked until they pay."
  echo "meterd adds paid phones to <paid>; 'sudo $0 status' shows them."
}

cmd_status() {
  need_root status
  echo "Paid phones and bytes used (pf table <paid> in $ANCHOR):"
  pfctl -a "$ANCHOR" -t paid -vT show 2>/dev/null || echo "  (rules not loaded)"
}

cmd_down() {
  need_root down
  pfctl -q -a "$ANCHOR" -F all 2>/dev/null || true
  if [ -s "$TOKEN_FILE" ]; then pfctl -q -X "$(cat "$TOKEN_FILE")" 2>/dev/null || true; rm -f "$TOKEN_FILE"; fi
  echo "MeterNet rules removed. Internet Sharing is unchanged."
}

case "${1:-}" in
  check) cmd_check ;;
  up) cmd_up ;;
  status) cmd_status ;;
  down) cmd_down ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
