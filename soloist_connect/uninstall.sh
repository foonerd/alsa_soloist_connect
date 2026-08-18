#!/bin/bash
if [ "$(id -u)" != "0" ]; then
  exec sudo -E bash "$0" "$@"
fi
echo "Uninstalling Spotify Soloist Connect..."

systemctl stop soloist.service 2>/dev/null || true
systemctl disable soloist.service 2>/dev/null || true
rm -f /etc/systemd/system/soloist.service
systemctl daemon-reload

rm -f /etc/sudoers.d/soloist_connect
rm -f /etc/sudoers.d/volumio-user-soloist_connect
rm -rf /data/soloist

echo "pluginuninstallend"
