#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/../../.." && pwd)"
NODE_BIN="$(command -v node || true)"
LABEL="com.service-manager"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$REPO_DIR/logs"

if [ -z "$NODE_BIN" ]; then
  echo "node not found in PATH"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${REPO_DIR}/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/service-manager.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/service-manager.err.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$UID" "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST_PATH"
launchctl enable "gui/$UID/$LABEL" 2>/dev/null || true
launchctl kickstart -k "gui/$UID/$LABEL" 2>/dev/null || true

echo "Installed: $PLIST_PATH"
