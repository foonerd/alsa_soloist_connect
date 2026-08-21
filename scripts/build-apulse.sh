#!/bin/bash
# UNUSED. The live payload is built by docker/run-docker-shim.sh from shim/.
# Leftover from the patched-apulse path; build-matrix.sh does not invoke this.
#
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
# The repository and commit come from the caller. See below.
#
echo "[+] Cloning apulse..."
cd "$BUILD_BASE"

# No defaults here, deliberately.
#
# The pin lives in exactly one place: docker/run-docker-apulse.sh, which passes
# it in. When these were duplicated as fallbacks, updating one and not the other
# produced a build of stock upstream that passed the ldd gate, the payload
# verification and the manifest prune, because every one of those compares the
# build to itself. A missing variable must stop the build, not silently select a
# different tree.
if [ -z "${APULSE_REPO:-}" ] || [ -z "${APULSE_REF:-}" ]; then
  echo "[!] ERROR: APULSE_REPO and APULSE_REF must be set by the caller"
  echo "    They are defined once in docker/run-docker-apulse.sh. This script"
  echo "    deliberately has no fallback: a second copy of the pin is how a"
  echo "    build of the wrong tree happened before."
  exit 1
fi

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
# Indent with a builtin loop, not sed.
printf '%s\n' "$LOCAL_COMMITS" | while IFS= read -r line; do
  printf '      %s\n' "$line"
done

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
#
# Trace build.
#
# APULSE_TRACE=1 compiles upstream's own tracing in. Every exported function
# logs its name and arguments on entry, which is the only way to see the whole
# conversation between the client and this library: not just the calls we
# happened to instrument, but all of them, in order, with values.
#
# The shipped default is 0. Four attempts at the lossless playback fault were
# aimed at inferred behaviour and missed, because what Soloist does with the
# timing struct was never observed, only assumed.
#
# A trace build is enormously verbose and slower. It goes to a separate output
# directory and is never installed into the plugin payload; the manifest in
# run-docker-apulse.sh would reject it anyway.
#
TRACE_LEVEL=0
STDERR_LEVEL=0
if [ "${APULSE_TRACE:-0}" = "1" ]; then
  TRACE_LEVEL=2
  STDERR_LEVEL=1
  echo "[+] TRACE BUILD: upstream tracing at level 2, logging to stderr"
  echo "    Diagnostic only. Do not ship this shim."
fi

echo ""
echo "[+] cmake / make..."
rm -rf build
mkdir build
cd build
cmake .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DUSE_BUNDLED_PULSEAUDIO_HEADERS=ON \
  -DWITH_TRACE="$TRACE_LEVEL" \
  -DLOG_TO_STDERR="$STDERR_LEVEL"

# cmake/pkg-config would link -lglib-2.0 dynamically. Replace with the
# archive paths so the linker treats them as inputs it cannot reorder away
# (same trick as ch341-i2c-usb/build for libfftw3 / libiniparser).
#
# Rewritten with shell builtins rather than sed -i. link.txt is a cmake
# generated file, and an in-place stream edit of a generated file is the
# failure mode this project does not accept: a pattern that silently matches
# nothing produces a dynamically linked shim that passes every later gate,
# because each of those gates compares the build to itself. Read, substitute
# the literal token, write, and count the files actually changed.
echo "[+] Patching link lines for static glib..."
PATCHED=0
while IFS= read -r -d '' f; do
  changed=0
  tmp="$f.static"
  : > "$tmp"
  line=""
  # read returns non-zero at EOF without a terminating newline, leaving the
  # partial line in $line. Handle that remainder after the loop so a file with
  # no trailing newline is reproduced byte for byte rather than gaining one.
  while IFS= read -r line; do
    case "$line" in
      *-lglib-2.0*)
        line="${line//-lglib-2.0/${GLIB_A} ${PCRE_A}}"
        changed=1
        ;;
    esac
    printf '%s\n' "$line" >> "$tmp"
  done < "$f"
  if [ -n "$line" ]; then
    case "$line" in
      *-lglib-2.0*)
        line="${line//-lglib-2.0/${GLIB_A} ${PCRE_A}}"
        changed=1
        ;;
    esac
    printf '%s' "$line" >> "$tmp"
  fi
  mv "$tmp" "$f"
  if [ "$changed" -eq 1 ]; then
    PATCHED=$((PATCHED + 1))
  fi
done < <(find . -name link.txt -print0)

# A build where nothing matched would link glib dynamically and then fail the
# ldd gate at step 5, but only after a full compile. Fail here instead, where
# the reason is still visible.
if [ "$PATCHED" -eq 0 ]; then
  echo "[!] ERROR: no link.txt contained -lglib-2.0"
  echo "    cmake did not request glib, or the link line format changed."
  echo "    Building on would produce a dynamically linked shim."
  exit 1
fi
echo "[+] Patched $PATCHED link.txt file(s)"

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
  # A trace build keeps its symbols: the point is to read what it did.
  if [ "${APULSE_TRACE:-0}" != "1" ]; then
    strip --strip-unneeded "$OUTPUT_DIR/$lib" || true
  fi
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
