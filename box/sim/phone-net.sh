#!/usr/bin/env bash
# A simulated phone for testing the Linux box without Wi-Fi hardware: a
# network namespace "phone" on a virtual cable to the box's hotspot interface
# mn-gw (10.42.0.1), NATed out of the uplink. openNDS guards mn-gw exactly as
# it would guard a Wi-Fi interface. Like a real phone, it gets its address
# from the box's DHCP (openNDS admits no other kind of client); dhclient keeps
# asking until the box is up.
#
#   sudo box/sim/phone-net.sh up      # create (and arm a 60 min auto-teardown)
#   sudo box/sim/phone-net.sh down    # remove everything it created
#   sudo box/sim/phone-net.sh uplink down|up   # the box's uplink fails / recovers
#   sudo box/sim/phone-net.sh renew   # push the auto-teardown 60 min out again
#   sudo ip netns exec phone curl ...  # act as the phone
#
# Touches only mn-gw, the "phone" namespace and its own nft table; never the
# uplink's own rules or SSH.
set -euo pipefail

UPLINK=${UPLINK:-$(ip -4 route show default | awk '{print $5; exit}')}
GW=10.42.0.1
# AppArmor's dhclient profile allows these paths.
DHCP_PID=/run/dhclient-meternet-phone.pid
DHCP_LEASES=/var/lib/dhcp/dhclient-meternet-phone.leases

up() {
  ip netns add phone
  ip link add mn-gw type veth peer name mn-phone
  ip link set mn-phone netns phone
  ip addr add "$GW/24" dev mn-gw
  ip link set mn-gw up
  ip netns exec phone ip link set mn-phone up
  ip netns exec phone ip link set lo up
  # The phone's own resolv.conf (ip netns exec bind-mounts it over
  # /etc/resolv.conf). dhclient writes the box's DNS into it.
  mkdir -p /etc/netns/phone
  echo "nameserver $GW" > /etc/netns/phone/resolv.conf

  sysctl -qw net.ipv4.ip_forward=1
  nft add table ip meternet_sim
  nft add chain ip meternet_sim post '{ type nat hook postrouting priority 100; }'
  nft add rule ip meternet_sim post ip saddr 10.42.0.0/24 oifname "$UPLINK" masquerade
  # Docker sets the forward policy to DROP; let mn-gw traffic reach openNDS,
  # whose own rules then decide (paid or not).
  if iptables -L DOCKER-USER >/dev/null 2>&1; then
    iptables -I DOCKER-USER -i mn-gw -j ACCEPT
    iptables -I DOCKER-USER -o mn-gw -j ACCEPT
  fi
  # A host firewall (ufw) would drop the phone's packets to the box before
  # openNDS's own rules see them. openNDS already limits what phones may reach
  # on the box, so let the hotspot interface through.
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
    ufw allow in on mn-gw comment "meternet sim phone" >/dev/null
  fi
  # Safety net: tear everything down in 60 minutes unless renewed.
  arm_teardown || true
  ip netns exec phone dhclient -4 -nw -pf "$DHCP_PID" -lf "$DHCP_LEASES" mn-phone
  echo "phone is up behind $GW (uplink $UPLINK), asking the box for an address; auto-teardown in 60 min"
  echo "its address: sudo ip netns exec phone ip -4 -o addr show dev mn-phone"
}

down() {
  systemctl stop 'meternet-sim-teardown*.timer' 2>/dev/null || true
  if [ -f "$DHCP_PID" ]; then
    ip netns exec phone dhclient -4 -r -pf "$DHCP_PID" -lf "$DHCP_LEASES" mn-phone 2>/dev/null \
      || kill "$(cat "$DHCP_PID")" 2>/dev/null || true
    rm -f "$DHCP_PID" "$DHCP_LEASES"
  fi
  iptables -D DOCKER-USER -i mn-gw -j ACCEPT 2>/dev/null || true
  iptables -D DOCKER-USER -o mn-gw -j ACCEPT 2>/dev/null || true
  nft delete table ip meternet_sim 2>/dev/null || true
  command -v ufw >/dev/null && ufw delete allow in on mn-gw >/dev/null 2>&1 || true
  ip link del mn-gw 2>/dev/null || true
  ip netns del phone 2>/dev/null || true
  rm -rf /etc/netns/phone
  echo "phone removed"
}

# The uplink failing, as the phone sees it: nothing it sends gets out and
# nothing comes back, open connections included (dropping the NAT rule alone
# would leave them running). Hooked in before openNDS's forward chain.
uplink() {
  case "${1:-}" in
    down)
      nft add chain ip meternet_sim uplink '{ type filter hook forward priority -200; }'
      nft add rule ip meternet_sim uplink iifname mn-gw oifname "$UPLINK" drop
      nft add rule ip meternet_sim uplink iifname "$UPLINK" oifname mn-gw drop
      echo "uplink down" ;;
    up)
      nft delete chain ip meternet_sim uplink 2>/dev/null || true
      echo "uplink up" ;;
    *) echo "usage: $0 uplink down|up" >&2; exit 1 ;;
  esac
}

# A fresh unit name each time: a stopped transient timer can leave its
# service loaded, and systemd-run refuses to reuse the name.
arm_teardown() {
  systemctl stop 'meternet-sim-teardown*.timer' 2>/dev/null || true
  systemd-run --quiet --unit "meternet-sim-teardown-$(date +%s)" --on-active=60min "$(readlink -f "$0")" down
}

renew() {
  arm_teardown
  echo "auto-teardown in 60 min"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  uplink) uplink "${2:-}" ;;
  renew) renew ;;
  *) sed -n '2,17p' "$0"; exit 1 ;;
esac
