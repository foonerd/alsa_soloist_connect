#!/bin/bash
# alsa_soloist_connect docker/run-docker-apulse.sh
# Builds the apulse Pulse-to-ALSA shim in a Bookworm container.
#
# Pattern matches peppyalsa-builds and ch341-i2c-usb/build:
#   per-arch Dockerfile, --platform, output in out/<arch>/.
#
# Usage: ./docker/run-docker-apulse.sh <arch> [--verbose]
#   arch: amd64, arm64, armhf

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

cd "$REPO_DIR"

ARCH="$1"
shift || true

VERBOSE=0
for arg in "$@"; do
  if [[ "$arg" == "--verbose" ]]; then
    VERBOSE=1
  fi
done

if [ -z "$ARCH" ]; then
  echo "Usage: $0 <arch> [--verbose]"
  echo ""
  echo "  arch: amd64, arm64, armhf"
  echo ""
  echo "Example:"
  echo "  $0 amd64"
  echo "  $0 arm64 --verbose"
  exit 1
fi

declare -A PLATFORM_MAP
PLATFORM_MAP=(
  ["amd64"]="linux/amd64"
  ["arm64"]="linux/arm64"
  ["armhf"]="linux/arm/v7"
)

declare -A LIB_PATH_MAP
LIB_PATH_MAP=(
  ["amd64"]="/usr/lib/x86_64-linux-gnu"
  ["arm64"]="/usr/lib/aarch64-linux-gnu"
  ["armhf"]="/usr/lib/arm-linux-gnueabihf"
)

if [[ -z "${PLATFORM_MAP[$ARCH]}" ]]; then
  echo "Error: unknown architecture: $ARCH"
  echo "Supported: amd64 arm64 armhf"
  exit 1
fi

PLATFORM="${PLATFORM_MAP[$ARCH]}"
LIB_PATH="${LIB_PATH_MAP[$ARCH]}"
DOCKERFILE="docker/Dockerfile.apulse.$ARCH"
IMAGE_NAME="soloist-apulse-builder:$ARCH"
OUTPUT_DIR="out/$ARCH"

if [ ! -f "$DOCKERFILE" ]; then
  echo "Error: Dockerfile not found: $DOCKERFILE"
  exit 1
fi

echo "========================================"
echo "Building apulse for $ARCH"
echo "========================================"
echo "  Platform:   $PLATFORM"
echo "  Lib path:   $LIB_PATH"
echo "  Dockerfile: $DOCKERFILE"
echo "  Image:      $IMAGE_NAME"
echo "  Output:     $REPO_DIR/$OUTPUT_DIR"
echo ""

echo "[+] Building Docker image..."
if [[ "$VERBOSE" -eq 1 ]]; then
  DOCKER_BUILDKIT=1 docker build --platform="$PLATFORM" --progress=plain \
    -t "$IMAGE_NAME" -f "$DOCKERFILE" .
else
  docker build --platform="$PLATFORM" --progress=auto \
    -t "$IMAGE_NAME" -f "$DOCKERFILE" .
fi
echo "[+] Docker image built: $IMAGE_NAME"
echo ""

mkdir -p "$OUTPUT_DIR"

#
# The payload manifest. One list, used for the copy, the verify and the prune.
#
# Declared rather than inferred because the install used to be
# `cp -a out/<arch>/. payload/`, which shipped whatever happened to be lying
# in out/. That is how a compiled test binary (pulse_clock_contract, 18 KB)
# and upstream's own launcher script ended up in the plugin package: out/ is
# not cleaned between builds, so any artefact that ever landed there shipped
# forever, including after the source that produced it was deleted.
#
# apulse (upstream's launcher) is deliberately excluded. It hardcodes
# /usr/local/lib/apulse, which does not exist on Volumio, and
# launch-soloist.sh sets LD_LIBRARY_PATH itself.
#
# Keep this list and alsa-lib/SOURCE.md in agreement.
PAYLOAD_FILES=(
  libpulse.so.0
  libpulse-simple.so.0
  libpulse-mainloop-glib.so.0
  SOURCE_REVISION
)

# Start from empty so a stale artefact cannot survive into the next build.
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# The apulse source. github.com/foonerd/apulse is upstream i-rinat/apulse at
# 5d654ce with the Volumio changes as commits on master.
#
# These are passed into the container, so they override the defaults in
# build-apulse.sh entirely. Keeping the same constant in two places is what let
# a build clone stock upstream while the build script had been updated to point
# at the fork: the script's defaults were never reached. If these move, the
# fallbacks in build-apulse.sh must move with them.
APULSE_REPO="${APULSE_REPO:-https://github.com/foonerd/apulse.git}"
# Exact commit, never a branch: a moving pin makes two builds of the same plugin
# version produce different shims.
APULSE_REF="${APULSE_REF:-b8ffd4acda327c95422f4739d32b3786a02863a8}"

echo "[+] Source: $APULSE_REPO ($APULSE_REF)"
echo ""

echo "[+] Running build inside container..."
docker run --rm --platform="$PLATFORM" \
  -v "$REPO_DIR/scripts:/build/scripts:ro" \
  -v "$REPO_DIR/$OUTPUT_DIR:/build/output" \
  -e "ARCH=$ARCH" \
  -e "LIB_PATH=$LIB_PATH" \
  -e "APULSE_REPO=$APULSE_REPO" \
  -e "APULSE_REF=$APULSE_REF" \
  "$IMAGE_NAME" \
  bash /build/scripts/build-apulse.sh

echo ""
echo "[+] Build complete for $ARCH"
echo "[+] Output in: $REPO_DIR/$OUTPUT_DIR"
ls -lh "$OUTPUT_DIR"

#
# Install into the plugin payload.
#
# This is not optional and not advice. The payload under soloist_connect/ is
# what gets zipped and installed on the device; leaving the copy to the caller
# means a stale shim can ship while the build output looks correct.
#
PAYLOAD_DIR="soloist_connect/alsa-lib/$ARCH"
echo ""
echo "[+] Installing into $PAYLOAD_DIR"
mkdir -p "$PAYLOAD_DIR"

# Copy only what the manifest declares.
for f in "${PAYLOAD_FILES[@]}"; do
  if [ ! -f "$OUTPUT_DIR/$f" ]; then
    echo "[!] ERROR: build did not produce $OUTPUT_DIR/$f"
    exit 1
  fi
  cp -a "$OUTPUT_DIR/$f" "$PAYLOAD_DIR/$f"
done

# Remove anything in the payload that the manifest does not declare, so a file
# added by an earlier build cannot linger and ship.
for existing in "$PAYLOAD_DIR"/*; do
  [ -e "$existing" ] || continue
  name="$(basename "$existing")"
  keep=0
  for f in "${PAYLOAD_FILES[@]}"; do
    if [ "$name" = "$f" ]; then
      keep=1
      break
    fi
  done
  if [ "$keep" -eq 0 ]; then
    echo "[+] Removing undeclared payload file: $name"
    rm -rf "$existing"
  fi
done

#
# Verify byte-for-byte. A mismatch here means the payload is not what was just
# built, and shipping it would be untraceable.
#
FAIL=0
for f in "${PAYLOAD_FILES[@]}"; do
  if [ ! -f "$PAYLOAD_DIR/$f" ]; then
    echo "[!] ERROR: $PAYLOAD_DIR/$f is missing after install"
    FAIL=1
    continue
  fi
  if ! cmp -s "$OUTPUT_DIR/$f" "$PAYLOAD_DIR/$f"; then
    echo "[!] ERROR: $f differs between $OUTPUT_DIR and $PAYLOAD_DIR"
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "[!] Payload install failed for $ARCH"
  exit 1
fi

echo "[+] Payload verified against build output:"
md5sum "$PAYLOAD_DIR"/libpulse*.so.0
echo "[+] apulse revision: $(cat "$PAYLOAD_DIR/SOURCE_REVISION")"
