# The hotspot's access point (box/linux/wifi.sh): hostapd and NAT. Runs
# privileged with host networking, because it configures the laptop's Wi-Fi
# card, IP forwarding and NAT. Build context: the repository root.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends hostapd iproute2 nftables iptables procps \
 && rm -rf /var/lib/apt/lists/*
COPY box/linux/wifi.sh /usr/local/bin/wifi.sh
RUN chmod +x /usr/local/bin/wifi.sh
ENTRYPOINT ["/usr/local/bin/wifi.sh"]
