#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/../../.." && pwd)"
NODE_BIN="$(command -v node || true)"
SERVICE_NAME="service-manager"
SERVICE_PATH="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
LOG_DIR="$REPO_DIR/logs"

if [ -z "$NODE_BIN" ]; then
  echo "node not found in PATH"
  exit 1
fi

mkdir -p "$HOME/.config/systemd/user" "$LOG_DIR"

cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=Service Manager
After=network.target

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
ExecStart=${NODE_BIN} ${REPO_DIR}/server.js
Restart=always
RestartSec=2
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"

echo "Installed: $SERVICE_PATH"
echo "If you want boot-time start before login, run: sudo loginctl enable-linger \"$USER\""
