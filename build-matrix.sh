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
echo "Output:"
for ARCH in "${ARCHITECTURES[@]}"; do
  if [ -d "out/$ARCH" ]; then
    echo "  out/$ARCH/"
    ls -lh "out/$ARCH/" 2>/dev/null | tail -n +2 | awk '{printf "    %s  %s\n", $9, $5}'
  fi
done
echo ""
echo "Copy into the plugin payload:"
echo "  for a in amd64 arm64 armhf; do"
echo "    cp -a out/\$a/. soloist_connect/alsa-lib/\$a/"
echo "  done"
