# MeterNet hotspot box (Linux): openNDS v11 (captive portal, built from the
# pinned release source) plus meterd in hotspot mode, in one container,
# because meterd drives openNDS through ndsctl's owner-only local socket.
# Runs with host networking and NET_ADMIN (openNDS manages nftables on the
# Wi-Fi interface). Build context: the repository root.

FROM debian:bookworm-slim AS opennds
ARG OPENNDS_VERSION=11.0.0
ARG OPENNDS_SHA256=33940f8ef52e958cdf37fd49ca20a8140b85a096d529cf4e0122592ac24ced00
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential libmicrohttpd-dev ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/opennds.tar.gz "https://github.com/openNDS/openNDS/archive/refs/tags/v${OPENNDS_VERSION}.tar.gz" \
 && echo "${OPENNDS_SHA256}  /tmp/opennds.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/opennds.tar.gz -C /tmp \
 && make -C "/tmp/openNDS-${OPENNDS_VERSION}" \
 && make -C "/tmp/openNDS-${OPENNDS_VERSION}" install DESTDIR=/out

FROM node:22-bookworm-slim
# openNDS's runtime: libmicrohttpd, and the tools its scripts call
# (nft, ip, awk, sed, grep, logger, sha256sum, base64 ...), and dnsmasq
# (DNS and DHCP for the hotspot). wget: openNDS's watchdog checks its own web
# server with it every checkinterval (libopennds.sh mhd_get_status); without
# it the check times out, openNDS restarts that server, and ndsctl stalls for
# ~4 s each time, long enough to push a cut past 15 s.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libmicrohttpd12 nftables iproute2 bash gawk procps bsdutils dnsmasq-base wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=opennds /out/ /
RUN rm -f /etc/config/opennds /etc/systemd/system/opennds.service
# openNDS v11 always puts authenticated connections into nftables flowtables
# (libopennds.sh gatewaycheck). Offloaded packets skip the forward path, so
# openNDS's per-client byte counters stop counting and a deauth doesn't end
# connections already offloaded: the meter could neither see usage nor cut.
# Remove the three "flow offload" rules (the chains stay and just return);
# fail the build if the script isn't the one this was checked against.
RUN f=/usr/lib/opennds/libopennds.sh \
 && [ "$(grep -c 'flow offload @ndsft' "$f")" = 3 ] \
 && sed -i '/nft add rule inet nds_[a-z]* nds_ft_[A-Z]* .*flow offload @ndsft/d' "$f" \
 && [ "$(grep -c 'flow offload' "$f")" = 0 ]

WORKDIR /app/meterd
COPY meterd/package.json meterd/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY meterd/ ./
COPY box/linux/opennds.conf.template box/linux/entrypoint.sh /app/box/
RUN chmod +x /app/box/entrypoint.sh

ENTRYPOINT ["/app/box/entrypoint.sh"]
