#!/usr/bin/env bash
# The "MeterNet-demo" Wi-Fi on a Linux laptop (docker-compose.yml, profile
# "wifi"): an open access point on GATEWAY_IFACE with hostapd, the box's
# address on it (BOX_LAN_IP/24), and NAT out of the uplink. openNDS (service
# "box") then decides who gets through; DHCP and DNS come from the box too.
#
# Before the first run, stop the desktop's network manager from using the
# Wi-Fi card, e.g.: nmcli device set wlan0 managed no
# Not yet run on real Wi-Fi hardware (week 3 was verified with the simulated
# phone in box/sim); see box/README.md.
set -euo pipefail
: "${GATEWAY_IFACE:?set GATEWAY_IFACE in box/box.env: the Wi-Fi interface, e.g. wlan0}"
: "${BOX_LAN_IP:?set BOX_LAN_IP in box/box.env, e.g. 192.168.2.1}"
SSID=${WIFI_SSID:-MeterNet-demo}
CHANNEL=${WIFI_CHANNEL:-6}
UPLINK=${UPLINK:-$(ip -4 route show default | awk '{print $5; exit}')}
[ -n "$UPLINK" ] || { echo "wifi: no default route; set UPLINK" >&2; exit 1; }
[ "$UPLINK" != "$GATEWAY_IFACE" ] || { echo "wifi: the uplink can't be the hotspot interface ($UPLINK)" >&2; exit 1; }
subnet="${BOX_LAN_IP%.*}.0/24"

cleanup() {
  nft delete table ip meternet_wifi 2>/dev/null || true
  iptables -D DOCKER-USER -i "$GATEWAY_IFACE" -j ACCEPT 2>/dev/null || true
  iptables -D DOCKER-USER -o "$GATEWAY_IFACE" -j ACCEPT 2>/dev/null || true
  ip addr del "$BOX_LAN_IP/24" dev "$GATEWAY_IFACE" 2>/dev/null || true
}
trap cleanup EXIT
cleanup

ip link set "$GATEWAY_IFACE" up
ip addr add "$BOX_LAN_IP/24" dev "$GATEWAY_IFACE"
sysctl -qw net.ipv4.ip_forward=1
nft add table ip meternet_wifi
nft add chain ip meternet_wifi post '{ type nat hook postrouting priority 100; }'
nft add rule ip meternet_wifi post ip saddr "$subnet" oifname "$UPLINK" masquerade
# Docker sets the forward policy to DROP; openNDS's own rules decide instead.
if iptables -L DOCKER-USER >/dev/null 2>&1; then
  iptables -I DOCKER-USER -i "$GATEWAY_IFACE" -j ACCEPT
  iptables -I DOCKER-USER -o "$GATEWAY_IFACE" -j ACCEPT
fi

conf=$(mktemp)
cat > "$conf" <<EOF
interface=$GATEWAY_IFACE
driver=nl80211
ssid=$SSID
hw_mode=g
channel=$CHANNEL
auth_algs=1
wmm_enabled=1
${WIFI_COUNTRY:+country_code=$WIFI_COUNTRY}
${WIFI_COUNTRY:+ieee80211d=1}
EOF
echo "wifi: \"$SSID\" on $GATEWAY_IFACE ($BOX_LAN_IP), uplink $UPLINK"
hostapd "$conf"
