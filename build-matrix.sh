#!/bin/bash
# Build apulse for every Volumio 4 architecture (amd64, arm64, armhf).
# Same matrix style as peppyalsa-builds/build-matrix.sh.

set -e

VERBOSE=""
for arg in "$@"; do
  if [[ "$arg" == "--verbose" ]]; then
    VERBOSE="--verbose"
  fi
done

echo "========================================"
echo "apulse build matrix (Volumio 4 / Bookworm)"
echo "========================================"
echo ""

ARCHITECTURES=("amd64" "arm64" "armhf")

for ARCH in "${ARCHITECTURES[@]}"; do
  echo ""
  echo "----------------------------------------"
  echo "Building for: $ARCH"
  echo "----------------------------------------"
  ./docker/run-docker-apulse.sh "$ARCH" $VERBOSE
done

echo ""
echo "========================================"
echo "Build matrix complete"
echo "========================================"
echo ""
echo "Payload (installed and verified by run-docker-apulse.sh):"
for ARCH in "${ARCHITECTURES[@]}"; do
  PAYLOAD_DIR="soloist_connect/alsa-lib/$ARCH"
  if [ -d "$PAYLOAD_DIR" ]; then
    echo "  $PAYLOAD_DIR/"
    md5sum "$PAYLOAD_DIR"/libpulse*.so.0 2>/dev/null | sed 's/^/    /'
  fi
done
