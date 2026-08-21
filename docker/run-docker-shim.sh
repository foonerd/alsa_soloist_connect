#!/bin/bash
# Builds the purpose-driven Pulse shim in a Bookworm container.
# Usage: ./docker/run-docker-shim.sh <arch> [--verbose]

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
  echo "  arch: amd64, arm64, armhf"
  exit 1
fi

declare -A PLATFORM_MAP=(
  ["amd64"]="linux/amd64"
  ["arm64"]="linux/arm64"
  ["armhf"]="linux/arm/v7"
)
if [[ -z "${PLATFORM_MAP[$ARCH]}" ]]; then
  echo "Error: unknown architecture: $ARCH"
  exit 1
fi

PLATFORM="${PLATFORM_MAP[$ARCH]}"
DOCKERFILE="docker/Dockerfile.apulse.$ARCH"
IMAGE_NAME="soloist-apulse-builder:$ARCH"
OUTPUT_DIR="out/$ARCH"

if [ ! -f "$DOCKERFILE" ]; then
  echo "Error: Dockerfile not found: $DOCKERFILE"
  exit 1
fi
if [ ! -f "$REPO_DIR/shim/CMakeLists.txt" ]; then
  echo "Error: shim sources not found"
  exit 1
fi

SHIM_REF="$(git -C "$REPO_DIR" rev-parse HEAD)"

echo "========================================"
echo "Building Pulse shim for $ARCH"
echo "========================================"
echo "  Platform: $PLATFORM"
echo "  Image:    $IMAGE_NAME"
echo "  Ref:      $SHIM_REF"
echo ""

echo "[+] Building Docker image..."
if [[ "$VERBOSE" -eq 1 ]]; then
  DOCKER_BUILDKIT=1 docker build --platform="$PLATFORM" --progress=plain \
    -t "$IMAGE_NAME" -f "$DOCKERFILE" .
else
  docker build --platform="$PLATFORM" --progress=auto \
    -t "$IMAGE_NAME" -f "$DOCKERFILE" .
fi

PAYLOAD_FILES=(
  libpulse.so.0
  SOURCE_REVISION
)

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

echo "[+] Running build inside container..."
docker run --rm --platform="$PLATFORM" \
  -v "$REPO_DIR/shim:/build/shim:ro" \
  -v "$REPO_DIR/scripts:/build/scripts:ro" \
  -v "$REPO_DIR/$OUTPUT_DIR:/build/output" \
  -e "ARCH=$ARCH" \
  -e "SHIM_REF=$SHIM_REF" \
  "$IMAGE_NAME" \
  bash /build/scripts/build-shim.sh

echo "[+] Build complete for $ARCH"
ls -lh "$OUTPUT_DIR"

PAYLOAD_DIR="soloist_connect/alsa-lib/$ARCH"
echo "[+] Installing into $PAYLOAD_DIR"
mkdir -p "$PAYLOAD_DIR"
for f in "${PAYLOAD_FILES[@]}"; do
  if [ ! -f "$OUTPUT_DIR/$f" ]; then
    echo "[!] ERROR: build did not produce $OUTPUT_DIR/$f"
    exit 1
  fi
  cp -a "$OUTPUT_DIR/$f" "$PAYLOAD_DIR/$f"
done
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
FAIL=0
for f in "${PAYLOAD_FILES[@]}"; do
  if ! cmp -s "$OUTPUT_DIR/$f" "$PAYLOAD_DIR/$f"; then
    echo "[!] ERROR: $f differs between build output and payload"
    FAIL=1
  fi
done
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
echo "[+] Payload verified"
echo "[+] shim revision: $(cat "$PAYLOAD_DIR/SOURCE_REVISION")"
