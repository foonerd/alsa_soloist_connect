#!/bin/bash
# Downloads the Spotify Soloist binary for this device's architecture from the
# official Spotify CDN. Spotify does not allow redistributing the binary, so it
# is always fetched directly from developer.spotify.com's published URLs:
# https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates
#
# Must run as root: the plugin tree is root-owned after `volumio plugin install`,
# and patchelf needs write access to the ELF. The UI updater calls this via sudo
# (see volumio-user-soloist_connect). Stage+patch first; only then replace the
# live binary, so a failed patch cannot leave an unpatched ARM build (that
# path is instant play→pause).
set -e

if [ "$(id -u)" != "0" ]; then
  exec sudo -E bash "$0" "$@"
fi

PLUGIN_DIR="/data/plugins/music_service/soloist_connect"
BIN_DIR="/data/soloist/bin"
STAGING="/data/soloist/staging"
mkdir -p "$BIN_DIR" "$STAGING"

# Userspace arch, not kernel uname. Official Volumio 4 Pi is armhf
# (recipes/devices/pi.sh) even on a 64-bit kernel; the stock Spotify
# plugin only ships armhf+amd64.
HERE="$(cd "$(dirname "$0")" && pwd)"
ARCH="$("$HERE/detect-arch.sh")"
case "$ARCH" in
  arm64)
    URL="https://soloist-builds.spotifycdn.com/soloist_release_arm64.tar.gz"
    ;;
  armhf)
    URL="https://soloist-builds.spotifycdn.com/soloist_release_arm32.tar.gz"
    ;;
  amd64)
    URL="https://soloist-builds.spotifycdn.com/soloist_release_x86_64.tar.gz"
    ;;
  *)
    echo "Unsupported architecture: $ARCH (need armhf, arm64, or amd64)"
    exit 1
    ;;
esac

echo "Downloading Spotify Soloist for userspace $ARCH (uname=$(uname -m) dpkg=$(dpkg --print-architecture 2>/dev/null || echo ?) bits=$(getconf LONG_BIT 2>/dev/null || echo ?)) ..."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fSL --retry 3 -o "$TMP/soloist.tar.gz" "$URL"
tar -xzf "$TMP/soloist.tar.gz" -C "$TMP"

SOLOIST_BIN=$(find "$TMP" -type f -name soloist | head -n 1)
if [ -z "$SOLOIST_BIN" ]; then
  echo "soloist executable not found in archive"
  exit 1
fi

# Stop the daemon so we are not patching a running inode.
systemctl stop soloist.service 2>/dev/null || true

STAGE="$STAGING/soloist"
rm -f "$STAGE"
cp -f "$SOLOIST_BIN" "$STAGE"
chmod 0755 "$STAGE"

# Fresh CDN binary is unpatched. Bookworm glibc 2.36 cannot run ARM Soloist
# (needs >= 2.38). Always rebuild/repair the matching sysroot and patch
# *before* replacing the live binary. A previous aarch64 sysroot plus a
# new armhf download is why launch then says "not ELF-patched".
install -m 0755 -o volumio -g volumio "$STAGE" "$BIN_DIR/soloist"
mkdir -p "$PLUGIN_DIR/bin"
install -m 0755 -o volumio -g volumio "$STAGE" "$PLUGIN_DIR/bin/soloist"
rm -f "$STAGE"

bash "$HERE/setup-glibc.sh" "$BIN_DIR/soloist"

PATCHELF="/usr/bin/patchelf"
[ -x "$PATCHELF" ] || PATCHELF="$(command -v patchelf || true)"
if [ -d /data/soloist/sysroot ]; then
  INTERP=$("$PATCHELF" --print-interpreter "$BIN_DIR/soloist" 2>/dev/null || true)
  case "$INTERP" in
    /data/soloist/sysroot*)
      echo "Patched interpreter: $INTERP"
      ;;
    *)
      echo "ERROR: soloist interpreter is '${INTERP:-unknown}', not under /data/soloist/sysroot" >&2
      exit 1
      ;;
  esac
fi

echo "Installed: $("$BIN_DIR/soloist" --version 2>/dev/null | head -n 1 || echo 'soloist')"
echo "Start with: sudo systemctl start soloist.service"
