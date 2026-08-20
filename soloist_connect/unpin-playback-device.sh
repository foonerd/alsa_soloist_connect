#!/bin/bash
# Remove a leftover systemd pin of APULSE_PLAYBACK_DEVICE so the env file
# PLAYBACK_DEVICE (written by the plugin) is what the launcher uses.
set -e

if [ "$(id -u)" != "0" ]; then
  exec sudo -E bash "$0" "$@"
fi

UNIT=/etc/systemd/system/soloist.service
if [ ! -f "$UNIT" ]; then
  exit 0
fi
if ! grep -q '^Environment=APULSE_PLAYBACK_DEVICE=' "$UNIT"; then
  exit 0
fi

tmp=$(mktemp)
sed '/^Environment=APULSE_PLAYBACK_DEVICE=/d' "$UNIT" > "$tmp"
mv "$tmp" "$UNIT"
chmod 644 "$UNIT"
systemctl daemon-reload
