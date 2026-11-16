#!/usr/bin/env bash
# Starts openNDS on GATEWAY_IFACE, waits for ndsctl, then runs meterd in
# hotspot mode. If either stops, the container stops (and compose restarts it).
set -euo pipefail

: "${GATEWAY_IFACE:?set GATEWAY_IFACE: the Wi-Fi interface the hotspot runs on}"
: "${DEVICE_SALT:?set DEVICE_SALT (openssl rand -hex 16) in box/.env}"

# Extra "allow tcp port N" router rules, e.g. EXTRA_ROUTER_PORTS="8400" for
# the simulated phone in tests, which calls meterd directly.
extra=""
for p in ${EXTRA_ROUTER_PORTS:-}; do
  [[ "$p" =~ ^[0-9]+$ ]] || { echo "bad port in EXTRA_ROUTER_PORTS: $p" >&2; exit 1; }
  extra+=$'\t'"list users_to_router 'allow tcp port $p'"$'\n'
done
mkdir -p /etc/config
sed -e "s/__GATEWAY_IFACE__/${GATEWAY_IFACE}/" -e "s/__DEBUGLEVEL__/${OPENNDS_DEBUGLEVEL:-1}/" \
    -e "s#__DHCP_LEASES__#${STATE_DIR:-/data/state}/dhcp.leases#" /app/box/opennds.conf.template \
  | awk -v extra="$extra" '{ if ($0 == "__EXTRA_ROUTER_RULES__") printf "%s", extra; else print }' \
  > /etc/config/opennds

echo "box: waiting for $GATEWAY_IFACE to have an IPv4 address"
until ip -4 -o addr show dev "$GATEWAY_IFACE" 2>/dev/null | grep -q inet; do sleep 1; done

gw_ip=$(ip -4 -o addr show dev "$GATEWAY_IFACE" | awk '{print $4}' | cut -d/ -f1 | head -1)

# DNS and DHCP for the hotspot. openNDS always lets phones reach the box on
# ports 53 and 67. DNS answers the box's own name with its hotspot address, so
# the HTTPS portal and the wallet's wss endpoint resolve locally.
# DHCP is not optional: openNDS only admits a client whose address is in this
# lease file (libopennds.sh dhcp_check). The file lives with meterd's state so
# leases survive a box restart. Default range: .10-.250 of the box's /24.
leases="${STATE_DIR:-/data/state}/dhcp.leases"
mkdir -p "$(dirname "$leases")"
dns=(--keep-in-foreground --interface="$GATEWAY_IFACE" --bind-interfaces --no-hosts --log-facility=-
     --dhcp-range="${DHCP_RANGE:-${gw_ip%.*}.10,${gw_ip%.*}.250,12h}" --dhcp-authoritative
     --dhcp-leasefile="$leases"
     --dhcp-option=option:router,"$gw_ip" --dhcp-option=option:dns-server,"$gw_ip")
[ -z "${BOX_FQDN:-}" ] || dns+=(--address="/$BOX_FQDN/$gw_ip")
dnsmasq "${dns[@]}" &
dnsm=$!

# A container restart keeps /tmp, and openNDS refuses to start while its last
# heartbeat (/tmp/ndscids/heartbeat) is under checkinterval seconds old
# (libopennds.sh check_heartbeat). This container only ever runs one openNDS,
# so its leftover runtime state is stale by definition.
rm -rf /tmp/ndscids /tmp/ndsctl.sock /tmp/ndslog /tmp/ndsdebuglevel

/usr/bin/opennds -f &
nds=$!
echo "box: waiting for openNDS"
for _ in $(seq 1 60); do ndsctl status >/dev/null 2>&1 && break; sleep 1; done
ndsctl status >/dev/null || { echo "box: openNDS did not start" >&2; exit 1; }

cd /app/meterd
FIREWALL=opennds LISTEN_HOST="${LISTEN_HOST:-127.0.0.1}" node --import tsx src/main-hotspot.ts &
meter=$!

trap 'kill $meter $nds $dnsm 2>/dev/null' TERM INT
wait -n $nds $meter $dnsm
echo "box: openNDS, meterd or dnsmasq stopped; exiting" >&2
kill $meter $nds $dnsm 2>/dev/null || true
exit 1
