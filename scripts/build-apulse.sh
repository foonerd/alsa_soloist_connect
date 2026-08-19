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
# Step 1: clone the Volumio apulse fork
#
# github.com/foonerd/apulse is upstream i-rinat/apulse at 5d654ce with our
# changes as commits on master. It was a patch series until the stack reached
# eight files: every consolidation shifted the next patch's line numbers, and a
# hand-edited hunk header twice cost a build by silently dropping the hunks
# after it. Git maintains the arithmetic now, and each change keeps its
# rationale in its commit message.
#
# Upstream is unchanged and still reachable: git log 5d654ce..HEAD shows exactly
# what we added, and git format-patch 5d654ce..HEAD produces submissions for the
# four fixes that are upstream bugs rather than Volumio policy.
#
# HTTPS deliberately: the container has no SSH key, and the fork is public.
#
echo "[+] Cloning apulse..."
cd "$BUILD_BASE"
APULSE_REPO="${APULSE_REPO:-https://github.com/foonerd/apulse.git}"
APULSE_REF="${APULSE_REF:-b8ffd4acda327c95422f4739d32b3786a02863a8}"

# Re-clone unless the existing checkout is from the repository we want. A
# container that has run before may hold a clone of a different remote: the
# first version of this script skipped the clone whenever any .git existed, and
# a stale clone of upstream produced a shim with none of our changes in it. The
# build reported success, the ldd gate passed, and the payload verified, because
# every one of those checks compares the output to itself.
if [ -d "$SOURCE_DIR/.git" ]; then
  HAVE_REMOTE="$(git -C "$SOURCE_DIR" config --get remote.origin.url || true)"
  if [ "$HAVE_REMOTE" != "$APULSE_REPO" ]; then
    echo "[+] Existing clone is from $HAVE_REMOTE, wanted $APULSE_REPO; re-cloning"
    rm -rf "$SOURCE_DIR"
  fi
fi
if [ ! -d "$SOURCE_DIR/.git" ]; then
  git clone "$APULSE_REPO" "$SOURCE_DIR"
fi
cd "$SOURCE_DIR"

# Fetch may legitimately fail offline when the pinned commit is already present,
# so it is not fatal on its own. The checkout below is what must succeed.
git fetch --all --tags --quiet || echo "[!] warning: fetch failed, using local objects only"

if ! git checkout --quiet --detach "$APULSE_REF"; then
  echo "[!] ERROR: cannot check out $APULSE_REF from $APULSE_REPO"
  echo "    The pinned commit is not in this clone. Building whatever HEAD"
  echo "    happens to be would ship a shim that is not the one requested."
  exit 1
fi

# The pin must be an exact commit, not a branch name. A moving pin would make
# two builds of the same plugin version produce different shims.
PINNED="$(git rev-parse HEAD)"
if [ "$PINNED" != "$APULSE_REF" ] && [ "$(git rev-parse --short "$APULSE_REF")" != "$(git rev-parse --short HEAD)" ]; then
  echo "[!] ERROR: HEAD is $PINNED but $APULSE_REF was requested"
  exit 1
fi

echo "[+] apulse at $(git rev-parse --short HEAD) ($(git log -1 --format=%s))"

# Our shim is upstream plus local commits, by definition. None means the wrong
# tree is being built, which is precisely the failure this check exists to
# catch: it happened once and produced a stock upstream payload that passed
# every other gate.
UPSTREAM_BASE=5d654cecd18474b4e0d885e774bc41fcbbc9818b
if ! git cat-file -e "$UPSTREAM_BASE^{commit}" 2>/dev/null; then
  echo "[!] ERROR: upstream base $UPSTREAM_BASE is not in this clone"
  exit 1
fi

LOCAL_COMMITS="$(git log --oneline "$UPSTREAM_BASE..HEAD")"
if [ -z "$LOCAL_COMMITS" ]; then
  echo "[!] ERROR: no local commits on top of upstream $UPSTREAM_BASE"
  echo "    This is stock apulse. The Volumio shim requires the fork's commits;"
  echo "    building without them would ship upstream behaviour silently."
  exit 1
fi

echo "[+] upstream base: $(git rev-parse --short $UPSTREAM_BASE)"
echo "[+] local commits on top of upstream:"
printf '%s\n' "$LOCAL_COMMITS" | sed 's/^/      /'

# A tree that is not clean means the pin does not describe what is being built.
if [ -n "$(git status --porcelain)" ]; then
  echo "[!] ERROR: apulse working tree is dirty at $PINNED"
  git status --short
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

echo "$PINNED" > "$OUTPUT_DIR/SOURCE_REVISION"

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
