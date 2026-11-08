#!/usr/bin/env bash
# Installs the pinned FNN release as a systemd service on the public server
# (Ubuntu, arm64 or x86_64). Idempotent: re-running keeps the existing key and data.
#
#   sudo bash install-fnn.sh
#
# Data, CKB key and password live in /var/lib/fnn (mode 700, user fnn).
# RPC stays on 127.0.0.1:8227; nothing here opens a firewall port.
set -euo pipefail

VERSION=v0.9.1
# Release "portable" builds, pinned by the sha256 GitHub publishes for each.
case "$(uname -m)" in
  aarch64) ARCH=aarch64; SHA256=c52c99b06bd954244b3fb91634d5b5031c23170208e46c7738ee308cb0bd3f0c ;;
  x86_64)  ARCH=x86_64;  SHA256=6425bc90ce971a5b8f10bd93667227cc932ee2e50a70f584e2c07590ce446d0d ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
ASSET=fnn_${VERSION}-${ARCH}-linux-portable.tar.gz
URL=https://github.com/nervosnetwork/fiber/releases/download/${VERSION}/${ASSET}
DATA=/var/lib/fnn

id fnn >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin fnn
install -d -m 700 -o fnn -g fnn "$DATA" "$DATA/ckb"

tmp=$(mktemp -d)
curl -fsSL "$URL" -o "$tmp/$ASSET"
echo "$SHA256  $tmp/$ASSET" | sha256sum -c -
tar -xzf "$tmp/$ASSET" -C "$tmp"
install -m 755 "$tmp/fnn" "$tmp/fnn-cli" /usr/local/bin/
"/usr/local/bin/fnn" --version

# Testnet config from the release; P2P on 8228, RPC on localhost only.
[ -f "$DATA/config.yml" ] || install -m 600 -o fnn -g fnn "$tmp/config/testnet/config.yml" "$DATA/config.yml"
rm -rf "$tmp"

# Fresh testnet key and wallet password on first install only.
# Subshells keep umask 077 from leaking into the systemd unit written below.
[ -n "$(ls -A "$DATA/ckb")" ] || (umask 077 && openssl rand -hex 32 > "$DATA/ckb/key")
[ -f "$DATA/password" ] || (umask 077 && openssl rand -hex 24 > "$DATA/password")
chown -R fnn:fnn "$DATA"

cat > /etc/systemd/system/fnn.service <<EOF
[Unit]
Description=Fiber Network Node ${VERSION} (MeterNet, CKB testnet)
After=network-online.target
Wants=network-online.target

[Service]
User=fnn
Group=fnn
WorkingDirectory=${DATA}
Environment=RUST_LOG=info
ExecStart=/bin/sh -c 'FIBER_SECRET_KEY_PASSWORD="\$(cat ${DATA}/password)" exec /usr/local/bin/fnn -c ${DATA}/config.yml -d ${DATA}'
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${DATA}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now fnn
echo "fnn service: $(systemctl is-active fnn)"
