#!/bin/bash
# The official Soloist binaries are built against glibc 2.38 or newer. Volumio 3
# (buster) has glibc 2.28, and glibc is never backported, so this script
# SIDELOADS a private copy of a newer glibc into /data/soloist/sysroot and
# ELF-patches soloist to use that copy.
#
# The copy is unpacked from the Debian trixie package archive, the first Debian
# release with glibc 2.38. Nothing is installed into the system: the player's
# own glibc, apt and packages are not touched, no repository is added, and the
# player stays on buster. Only the Soloist process uses the sysroot.
#
# patchelf, the tool that rewrites the binary, is sideloaded the same way,
# because buster's apt offers none. This script never runs apt.
set -e

if [ "$(id -u)" != "0" ]; then
  exec sudo -E bash "$0" "$@"
fi

PLUGIN_DIR="/data/plugins/music_service/soloist_connect"
BIN_DIR="/data/soloist/bin"
SYSROOT="/data/soloist/sysroot"
REQUIRED_MAJOR=2
REQUIRED_MINOR=38
BIN="${1:-$BIN_DIR/soloist}"

HERE="$(cd "$(dirname "$0")" && pwd)"
ARCH="$("$HERE/detect-arch.sh")"
case "$ARCH" in
  amd64) DEB_ARCH="amd64"; TRIPLET="x86_64-linux-gnu"; LOADER_NAME="ld-linux-x86-64.so.2" ;;
  arm64) DEB_ARCH="arm64"; TRIPLET="aarch64-linux-gnu"; LOADER_NAME="ld-linux-aarch64.so.1" ;;
  armhf) DEB_ARCH="armhf"; TRIPLET="arm-linux-gnueabihf"; LOADER_NAME="ld-linux-armhf.so.3" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# If the system glibc is already new enough, no sideload is needed.
CUR=$(ldd --version | head -n1 | grep -oE '[0-9]+\.[0-9]+' | tail -n1)
CUR_MAJOR=${CUR%%.*}
CUR_MINOR=${CUR##*.}
if [ "$CUR_MAJOR" -gt "$REQUIRED_MAJOR" ] || { [ "$CUR_MAJOR" -eq "$REQUIRED_MAJOR" ] && [ "$CUR_MINOR" -ge "$REQUIRED_MINOR" ]; }; then
  echo "System glibc $CUR is new enough; no sideload needed."
  rm -f "$BIN_DIR/soloist-run" "$PLUGIN_DIR/bin/soloist-run"
  exit 0
fi

have_loader() {
  [ -n "$(find "$SYSROOT" -name "$LOADER_NAME" 2>/dev/null | head -n 1)" ]
}

if [ -d "$SYSROOT" ] && ! have_loader; then
  echo "Sysroot exists but has no $LOADER_NAME (need $ARCH). Rebuilding."
  rm -rf "$SYSROOT"
fi

# Sideload: unpack the named packages from the Debian trixie archive into the
# private sysroot with dpkg-deb -x. This is a file copy into $SYSROOT, not a
# package install: dpkg and apt never see these packages and the system is
# not modified. TMP is script-global so the EXIT trap, set once below, cleans
# up after a failed download too.
MIRROR="http://deb.debian.org/debian"
TMP=""
trap '[ -n "$TMP" ] && rm -rf "$TMP"' EXIT
sideload_packages() {
  local PKG FILE
  mkdir -p "$SYSROOT"
  TMP=$(mktemp -d)

  echo "Sideload: fetching the Debian trixie package index for $DEB_ARCH (for $SYSROOT only; the system is not touched)..."
  curl -fsSL --retry 3 -o "$TMP/Packages.gz" \
    "$MIRROR/dists/trixie/main/binary-$DEB_ARCH/Packages.gz"

  for PKG in "$@"; do
    FILE=$(zcat "$TMP/Packages.gz" | awk -v p="$PKG" '
      $1=="Package:" { found = ($2==p) }
      found && $1=="Filename:" { print $2; exit }')
    if [ -z "$FILE" ]; then
      echo "Sideload: could not locate package $PKG in the Debian trixie index"
      exit 1
    fi
    echo "Sideload: unpacking $PKG into $SYSROOT ..."
    curl -fsSL --retry 3 -o "$TMP/$PKG.deb" "$MIRROR/$FILE"
    dpkg-deb -x "$TMP/$PKG.deb" "$SYSROOT"
  done
  rm -rf "$TMP"
  TMP=""
}

if [ -d "$SYSROOT" ] && have_loader; then
  echo "Sideload already in place: $SYSROOT has the $ARCH glibc ($LOADER_NAME)."
else
  echo "System glibc is $CUR; sideloading a private $ARCH glibc into $SYSROOT (the system glibc is not touched)..."
  sideload_packages libc6 libgcc-s1 libstdc++6 libatomic1
fi

if ! have_loader; then
  echo "ERROR: $LOADER_NAME still missing from $SYSROOT after sideload." >&2
  exit 1
fi

# patchelf: sideloaded into the same private sysroot and run through the
# sideloaded loader. The wrapper lives in $BIN_DIR, where the other scripts
# look when there is no system patchelf. A system patchelf, if someone
# installed one, is used instead.
if ! command -v patchelf >/dev/null 2>&1 && [ ! -x /usr/bin/patchelf ]; then
  if [ ! -x "$SYSROOT/usr/bin/patchelf" ]; then
    echo "Sideload: no system patchelf; unpacking patchelf into $SYSROOT (the system is not touched)..."
    sideload_packages patchelf
  fi
  LOADER=$(find "$SYSROOT" -name "$LOADER_NAME" 2>/dev/null | head -n 1)
  LIBPATH="$SYSROOT/lib/$TRIPLET:$SYSROOT/usr/lib/$TRIPLET:$SYSROOT/lib:$SYSROOT/usr/lib"
  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/patchelf" << EOF
#!/bin/sh
# patchelf sideloaded into $SYSROOT, run with the sideloaded glibc; the system is not touched (written by setup-glibc.sh)
exec "$LOADER" --library-path "$LIBPATH" "$SYSROOT/usr/bin/patchelf" "\$@"
EOF
  chmod 0755 "$BIN_DIR/patchelf"
  PATCHELF_VER=$("$BIN_DIR/patchelf" --version 2>/dev/null || true)
  if [ -z "$PATCHELF_VER" ]; then
    echo "ERROR: the sideloaded patchelf does not run from $SYSROOT." >&2
    exit 1
  fi
  echo "Sideload: patchelf $PATCHELF_VER ready in $BIN_DIR"
fi

if [ ! -f "$BIN" ]; then
  echo "No soloist binary at $BIN yet; sysroot is ready."
  exit 0
fi

if ! bash "$HERE/patch-soloist.sh" "$BIN"; then
  echo "ERROR: patchelf failed; refusing to leave an unpatched ARM binary." >&2
  exit 1
fi
rm -f "$BIN_DIR/soloist-run" "$PLUGIN_DIR/bin/soloist-run"

chown -R volumio:volumio "$SYSROOT" "$BIN_DIR"

echo "Sideload complete. Test with: $BIN --version"
