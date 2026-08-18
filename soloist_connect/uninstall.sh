#!/bin/bash
# Invoked by Volumio as: sudo -S sh uninstall.sh
# It runs under /bin/sh, not bash, so keep this POSIX.
if [ "$(id -u)" != "0" ]; then
  exec sudo -E bash "$0" "$@"
fi
echo "Uninstalling Spotify Soloist Connect..."

ENV_FILE="/data/soloist/soloist.env"

systemctl stop soloist.service 2>/dev/null || true
systemctl disable soloist.service 2>/dev/null || true
rm -f /etc/systemd/system/soloist.service
systemctl daemon-reload

rm -f /etc/sudoers.d/soloist_connect
rm -f /etc/sudoers.d/volumio-user-soloist_connect

# "Retain my API key". Volumio deletes the plugin's own configuration after this
# script runs (removePluginFromConfiguration does rm -rf on
# /data/configuration/music_service/soloist_connect), so the key cannot survive
# there. The plugin therefore writes the setting into the env file, which is the
# only thing left that can be consulted here.
#
# Default is to retain. An unreadable or missing env file means there is nothing
# worth keeping anyway, so the full removal path is taken.
RETAIN="false"
if [ -f "$ENV_FILE" ]; then
  RETAIN=$(sed -n 's/^RETAIN_API_KEY="\(.*\)"$/\1/p' "$ENV_FILE")
fi

if [ "$RETAIN" = "true" ]; then
  echo "Retaining API key and paired session in /data/soloist"
  # Removed: the downloaded binary, its staging copy, the sideloaded glibc and
  # the playback cache. All are re-created on install.
  rm -rf /data/soloist/bin
  rm -rf /data/soloist/staging
  rm -rf /data/soloist/sysroot
  rm -rf /data/soloist/cache
  # Kept: soloist.env (holds API_KEY, mode 0600) and data/ (device identity and
  # the stored Spotify Connect session). Removing data/ would force re-pairing.
else
  echo "Removing all Soloist data including the API key"
  rm -rf /data/soloist
fi

echo "pluginuninstallend"
