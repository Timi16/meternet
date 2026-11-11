#!/usr/bin/env bash
# Runs meterd (web MVP) as a systemd service on the public server. Run
# sync-meterd.sh first (code), and sync-content.sh (gateway content).
# Idempotent: keeps an existing env file, so DEVICE_SALT never changes.
#
#   sudo bash install-meterd.sh
#
# Secrets live in /home/meternet/meternet/meterd.env (mode 600), outside the
# synced code folder and outside git.
set -euo pipefail

HOME_DIR=/home/meternet/meternet
ENV_FILE=$HOME_DIR/meterd.env
LOG_DIR=$HOME_DIR/logs/web

install -d -m 755 -o meternet -g meternet "$HOME_DIR/logs" "$LOG_DIR"
if [ ! -f "$ENV_FILE" ]; then
  (umask 077 && cat > "$ENV_FILE" <<EOF
# meterd (web MVP). See .env.example in the repo for every option.
BOX_RPC=http://127.0.0.1:8227
DEVICE_SALT=$(openssl rand -hex 16)
CHUNK_PRICE_SHANNONS=10000000
LOG_DIR=$LOG_DIR
CONTENT_DIR=/srv/meternet/content
LISTEN_HOST=127.0.0.1
LISTEN_PORT=8300
EOF
  )
  chown meternet:meternet "$ENV_FILE"
fi

cat > /etc/systemd/system/meterd.service <<EOF
[Unit]
Description=MeterNet meterd (web MVP meter and gateway)
After=network-online.target fnn.service
Wants=network-online.target

[Service]
User=meternet
Group=meternet
WorkingDirectory=$HOME_DIR/meterd
EnvironmentFile=$ENV_FILE
ExecStart=/usr/local/bin/node --import tsx src/main.ts
Restart=on-failure
RestartSec=3
# SIGTERM ends sessions cleanly (session_ended lines) before exit.
TimeoutStopSec=20
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$LOG_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable meterd
systemctl restart meterd
sleep 2
echo "meterd: $(systemctl is-active meterd)"
curl -fsS http://127.0.0.1:8300/api/health && echo
