#!/bin/bash
# Runs inside the Bookworm container. Builds the purpose-driven Pulse shim.
# Runtime deps: libasound2 + libc. No glib, no libpulse.

set -euo pipefail

echo "[+] Starting Pulse shim build"
echo "[+] Architecture: ${ARCH:-unknown}"

SOURCE_DIR="/build/shim"
OUTPUT_DIR="/build/output"
mkdir -p "$OUTPUT_DIR"

if [ ! -f "$SOURCE_DIR/CMakeLists.txt" ]; then
  echo "[!] ERROR: shim sources not mounted at $SOURCE_DIR"
  exit 1
fi

if [ -z "${SHIM_REF:-}" ]; then
  echo "[!] ERROR: SHIM_REF must be set by the caller"
  exit 1
fi

rm -rf /build/shim-build
cmake -S "$SOURCE_DIR" -B /build/shim-build
cmake --build /build/shim-build -j"$(nproc)"

SO="$(find /build/shim-build -name 'libpulse.so.0*' -type f | head -n 1)"
if [ -z "$SO" ]; then
  echo "[!] ERROR: libpulse.so.0 was not produced"
  exit 1
fi

cp -a "$SO" "$OUTPUT_DIR/libpulse.so.0"
chmod 0755 "$OUTPUT_DIR/libpulse.so.0"
echo "$SHIM_REF" > "$OUTPUT_DIR/SOURCE_REVISION"

echo "[+] Dynamic dependencies:"
ldd "$OUTPUT_DIR/libpulse.so.0"
if ldd "$OUTPUT_DIR/libpulse.so.0" | grep -E 'libpulse\.so|libglib|libpcre'; then
  echo "[!] ERROR: shim must not link libpulse or glib"
  exit 1
fi

echo "[+] Symbols (pa_*):"
nm -D "$OUTPUT_DIR/libpulse.so.0" | awk '/ T pa_/ {print $3}' | sort
echo "[+] Build complete"
