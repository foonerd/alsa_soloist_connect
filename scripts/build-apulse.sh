#!/bin/bash
# alsa_soloist_connect scripts/build-apulse.sh
# Runs inside the Bookworm container. Builds apulse with glib statically
# linked so the result only needs libraries present on a stock Volumio 4
# image (libasound2 + base libc).
#
# Authority on allowed runtime deps: volumio-os/recipes/base/VolumioBase.conf
# (libasound2). libglib2.0 is NOT on that list.

set -euo pipefail

echo "[+] Starting apulse build"
echo "[+] Architecture: ${ARCH:-unknown}"
echo "[+] Library path: ${LIB_PATH:-unknown}"
echo "[+] Source: ${APULSE_REPO:-} (${APULSE_REF:-})"
echo ""

BUILD_BASE="/build"
SOURCE_DIR="$BUILD_BASE/apulse"
OUTPUT_DIR="$BUILD_BASE/output"
mkdir -p "$OUTPUT_DIR"

#
# Step 1: clone apulse
#
echo "[+] Cloning apulse..."
cd "$BUILD_BASE"
if [ ! -d "$SOURCE_DIR/.git" ]; then
  git clone "${APULSE_REPO:-https://github.com/i-rinat/apulse.git}" "$SOURCE_DIR"
fi
cd "$SOURCE_DIR"
git checkout "${APULSE_REF:-5d654cecd18474b4e0d885e774bc41fcbbc9818b}"
echo "[+] apulse at $(git rev-parse --short HEAD) ($(git log -1 --format=%s))"

#
# Step 1b: apply local patches
#
# Applied in filename order against the pinned revision. A patch that does not
# apply is a hard failure: shipping an unpatched shim would silently restore
# upstream buffering behaviour.
#
PATCH_DIR="$BUILD_BASE/patches"
if [ -d "$PATCH_DIR" ]; then
  git checkout -- .
  for patch in "$PATCH_DIR"/*.patch; do
    [ -e "$patch" ] || continue
    echo "[+] Applying $(basename "$patch")"
    if ! patch -p1 --forward --batch < "$patch"; then
      echo "[!] ERROR: $(basename "$patch") did not apply to $(git rev-parse --short HEAD)"
      exit 1
    fi
  done
else
  echo "[!] ERROR: no patch directory at $PATCH_DIR"
  exit 1
fi

#
# Step 2: locate static glib + pcre2 (not on Volumio; must not be dynamic)
#
GLIB_A=$(find /usr -name 'libglib-2.0.a' 2>/dev/null | head -1)
PCRE_A=$(find /usr -name 'libpcre2-8.a' 2>/dev/null | head -1)
if [ -z "$GLIB_A" ] || [ -z "$PCRE_A" ]; then
  echo "[!] ERROR: static libglib-2.0.a or libpcre2-8.a not found"
  echo "    Install libglib2.0-dev and libpcre2-dev in the image."
  exit 1
fi
echo "[+] Static glib: $GLIB_A"
echo "[+] Static pcre2: $PCRE_A"

#
# Step 3: configure + build
#
echo ""
echo "[+] cmake / make..."
rm -rf build
mkdir build
cd build
cmake .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DUSE_BUNDLED_PULSEAUDIO_HEADERS=ON \
  -DWITH_TRACE=0 \
  -DLOG_TO_STDERR=0

# cmake/pkg-config would link -lglib-2.0 dynamically. Replace with the
# archive paths so the linker treats them as inputs it cannot reorder away
# (same trick as ch341-i2c-usb/build for libfftw3 / libiniparser).
echo "[+] Patching link lines for static glib..."
find . -name link.txt -print0 | while IFS= read -r -d '' f; do
  sed -i "s|-lglib-2.0|${GLIB_A} ${PCRE_A}|g" "$f"
done

make -j"$(nproc)"

#
# Step 4: collect artefacts
#
echo ""
echo "[+] Collecting libraries..."
# cmake names them libpulse.so, libpulse.so.0, etc.
for lib in libpulse.so.0 libpulse-simple.so.0 libpulse-mainloop-glib.so.0; do
  SRC=$(find . -name "$lib" -type f -o -name "$lib" -type l | head -1)
  if [ -z "$SRC" ]; then
    echo "[!] ERROR: $lib not produced"
    exit 1
  fi
  # Prefer the real file, not a symlink, then write a stable soname copy.
  REAL=$(readlink -f "$SRC")
  cp -a "$REAL" "$OUTPUT_DIR/$lib"
  chmod 0755 "$OUTPUT_DIR/$lib"
  strip --strip-unneeded "$OUTPUT_DIR/$lib" || true
done

if [ -f apulse ]; then
  cp -a apulse "$OUTPUT_DIR/apulse"
  chmod 0755 "$OUTPUT_DIR/apulse"
fi

echo "$(git -C "$SOURCE_DIR" rev-parse HEAD)" > "$OUTPUT_DIR/SOURCE_REVISION"

#
# Step 5: ldd gate — fail if anything not on a stock Volumio image is linked
#
echo ""
echo "[+] Library info:"
ls -l "$OUTPUT_DIR"/libpulse*.so.0
if command -v file >/dev/null 2>&1; then
  file "$OUTPUT_DIR"/libpulse*.so.0
fi

echo ""
echo "[+] Dynamic dependencies (must only be ALSA + base libc + sibling apulse):"
FAIL=0
export LD_LIBRARY_PATH="$OUTPUT_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
for lib in "$OUTPUT_DIR"/libpulse.so.0 "$OUTPUT_DIR"/libpulse-simple.so.0 "$OUTPUT_DIR"/libpulse-mainloop-glib.so.0; do
  echo "--- $(basename "$lib") ---"
  ldd "$lib" || true
  # Allowed: interpreter, libc family, libasound2, and our own libpulse*.
  EXTRA=$(ldd "$lib" | awk '/=>/ {print $1}' | grep -vE \
    '^(linux-vdso\.so|ld-linux|libc\.so|libm\.so|libpthread\.so|libdl\.so|librt\.so|libasound\.so|libgcc_s\.so|libstdc\+\+\.so|libpulse\.so|libpulse-simple\.so|libpulse-mainloop-glib\.so)' \
    || true)
  if [ -n "$EXTRA" ]; then
    echo "[!] ERROR: $(basename "$lib") links libraries not on stock Volumio 4:"
    echo "$EXTRA"
    FAIL=1
  else
    echo "[+] OK: $(basename "$lib") runtime deps are stock"
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "[!] Build rejected: extra dynamic libraries would break on Volumio 4"
  exit 1
fi

echo ""
echo "[+] Output:"
ls -lh "$OUTPUT_DIR"
