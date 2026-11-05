#!/bin/bash
# The shim release line, one tool for the moves around it:
#
#   scripts/shim-release.sh version
#   scripts/shim-release.sh archive <arch>
#   scripts/shim-release.sh pin <tag>
#   scripts/shim-release.sh fetch [dir]
#   scripts/shim-release.sh verify [dir]
#
# A shim release is the tag shim-v<version> on this repository, built and
# published by .github/workflows/shim-release.yml: one archive per
# architecture, soloist-shim-<version>-<arch>.tar.gz, holding libpulse.so.0,
# SOURCE_REVISION and LICENSE, with the digests in SHA256SUMS. The plugin
# payload is the first two; LICENSE rides along for whoever unpacks the
# archive on its own.
#
# version  prints the shim version, CMake's VERSION in shim/CMakeLists.txt.
# archive  takes out/<arch>/ as docker/run-docker-shim.sh leaves it and writes
#          the archive into dist/. The build must be of HEAD with a clean
#          shim/, so SOURCE_REVISION names the commit the archive came from.
#          The archive is reproducible: entries sorted, owner 0:0, mtime the
#          commit time, gzip without a name or timestamp.
# pin      downloads one release's archives, checks them against its
#          SHA256SUMS, unpacks them into soloist_connect/alsa-lib/<arch>/ and
#          writes the pin, soloist_connect/alsa-lib/RELEASE: the tag on the
#          first line, then the digest of each archive and of each unpacked
#          file. The version stays stated by hand where the docs name it;
#          verify checks the two SOURCE.md files.
# fetch    downloads the archives the pin names into <dir> (dist/shim),
#          checks them against the pin, unpacks them into <dir>/<arch>/ and
#          verifies the result. scripts/package.sh --shim <dir> compares the
#          tree it zips with that.
# verify   checks the payload in <dir> (soloist_connect/alsa-lib) against the
#          pin, and that both alsa-lib/SOURCE.md files state the pinned
#          version. scripts/check.sh runs it.
#
# Releases are read from github.com/foonerd/alsa_soloist_connect.
# SHIM_RELEASE_REPO names another owner/repo; SHIM_RELEASE_BASE another
# download base, a mirror or file:///... for a local check.
set -euo pipefail
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"

REPO=${SHIM_RELEASE_REPO:-foonerd/alsa_soloist_connect}
BASE=${SHIM_RELEASE_BASE:-https://github.com/$REPO/releases/download}
ARCHES=(amd64 arm64 armhf)
PAYLOAD=(libpulse.so.0 SOURCE_REVISION)
TREE=soloist_connect/alsa-lib
PIN=$TREE/RELEASE
TMP=""
trap '[ -z "$TMP" ] || rm -rf "$TMP"' EXIT

die() { echo "shim-release: $*" >&2; exit 1; }

arch_ok() {
  case "$1" in
    amd64|arm64|armhf) ;;
    *) die "unknown arch '$1' (amd64, arm64, armhf)" ;;
  esac
}

version() {
  local v
  v=$(sed -n 's/^[[:space:]]*VERSION[[:space:]]*\([0-9][0-9.]*\)[[:space:]]*$/\1/p' shim/CMakeLists.txt)
  [ -n "$v" ] || die "shim/CMakeLists.txt has no VERSION line"
  [ "$(printf '%s\n' "$v" | wc -l)" -eq 1 ] || die "shim/CMakeLists.txt has more than one VERSION line"
  printf '%s\n' "$v"
}

# The archive names of one release, in architecture order.
archives() {
  local v=${1#shim-v} a
  for a in "${ARCHES[@]}"; do
    printf 'soloist-shim-%s-%s.tar.gz\n' "$v" "$a"
  done
}

# The payload paths under a payload directory, in architecture order.
payload_paths() {
  local a f
  for a in "${ARCHES[@]}"; do
    for f in "${PAYLOAD[@]}"; do
      printf '%s/%s\n' "$a" "$f"
    done
  done
}

archive() {
  local arch=$1 v out head rev tarball f
  arch_ok "$arch"
  v=$(version)
  out=out/$arch
  for f in "${PAYLOAD[@]}"; do
    [ -f "$out/$f" ] || die "$out/$f is missing; docker/run-docker-shim.sh $arch builds it"
  done
  head=$(git rev-parse HEAD)
  rev=$(tr -d '[:space:]' < "$out/SOURCE_REVISION")
  [ "$rev" = "$head" ] || die "$out was built from $rev, HEAD is $head; rebuild"
  [ -z "$(git status --porcelain -- shim)" ] || die "shim/ has uncommitted changes; an archive is of a commit"
  mkdir -p dist
  tarball=dist/soloist-shim-$v-$arch.tar.gz
  tar --sort=name --owner=0 --group=0 --numeric-owner \
      --mtime="@$(git log -1 --format=%ct)" -cf - \
      -C "$out" "${PAYLOAD[@]}" -C "$ROOT" LICENSE | gzip -n -9 > "$tarball"
  echo "shim-release: $tarball: $(stat -c %s "$tarball") bytes, sha256 $(sha256sum "$tarball" | cut -d' ' -f1), from $rev"
}

pin_tag() {
  [ -f "$PIN" ] || die "no pin at $PIN; pin <tag> writes it"
  head -n 1 "$PIN"
}

# The pin's digest lines whose file name starts with the given pattern.
pin_sums() {
  grep -E "^[0-9a-f]{64}  $1" "$PIN" || true
}

# download <tag> <dir> <name>...: the named assets of a release into dir.
download() {
  local tag=$1 dir=$2 f
  shift 2
  mkdir -p "$dir"
  for f in "$@"; do
    curl -fsSL --retry 3 --retry-delay 2 -o "$dir/$f" "$BASE/$tag/$f" \
      || die "$f is not on release $tag ($BASE/$tag/$f)"
  done
}

# unpack <dir> <dest> <version>: each archive in dir into dest/<arch>/, the
# payload members only.
unpack() {
  local dir=$1 dest=$2 v=$3 a
  for a in "${ARCHES[@]}"; do
    rm -rf "${dest:?}/$a"
    mkdir -p "$dest/$a"
    tar -C "$dest/$a" -xzf "$dir/soloist-shim-$v-$a.tar.gz" "${PAYLOAD[@]}"
  done
}

pin() {
  local tag=$1 v files paths
  case "$tag" in
    shim-v[0-9]*) ;;
    *) die "a shim release tag is shim-v<version>, not '$tag'" ;;
  esac
  v=${tag#shim-v}
  mapfile -t files < <(archives "$tag")
  mapfile -t paths < <(payload_paths)
  TMP=$(mktemp -d)
  download "$tag" "$TMP" SHA256SUMS "${files[@]}"
  (cd "$TMP" && sha256sum -c --quiet --ignore-missing SHA256SUMS) \
    || die "the archives of $tag do not match its SHA256SUMS"
  unpack "$TMP" "$TREE" "$v"
  {
    printf '%s\n' "$tag"
    (cd "$TMP" && sha256sum "${files[@]}")
    (cd "$TREE" && sha256sum "${paths[@]}")
  } > "$PIN"
  echo "shim-release: $tag pinned in $PIN; $TREE/<arch>/ is that release's payload"
  echo "shim-release: the version is stated by hand: 'Library version is **$v**' in $TREE/SOURCE.md and buster/plugin/alsa-lib/SOURCE.md; the shim version is also named in soloist_connect/package.json (details) and README.md"
}

fetch() {
  local dir=$1 tag v files
  case "$dir" in
    ""|.|/|"$TREE") die "fetch needs its own directory, not '$dir'" ;;
  esac
  tag=$(pin_tag)
  v=${tag#shim-v}
  mapfile -t files < <(archives "$tag")
  rm -rf "$dir"
  download "$tag" "$dir" "${files[@]}"
  pin_sums soloist-shim- | (cd "$dir" && sha256sum -c --quiet) \
    || die "the archives of $tag differ from the pin $PIN"
  unpack "$dir" "$dir" "$v"
  verify "$dir"
}

verify() {
  local dir=$1 tag v f want
  tag=$(pin_tag)
  v=${tag#shim-v}
  [ -d "$dir" ] || die "$dir is not a directory"
  want=$(( ${#ARCHES[@]} * ${#PAYLOAD[@]} ))
  [ "$(pin_sums '(amd64|arm64|armhf)/' | wc -l)" -eq "$want" ] || die "$PIN does not list the $want payload files"
  pin_sums '(amd64|arm64|armhf)/' | (cd "$dir" && sha256sum -c --quiet) \
    || die "the payload in $dir is not release $tag as pinned"
  for f in "$TREE/SOURCE.md" buster/plugin/alsa-lib/SOURCE.md; do
    grep -q "Library version is \*\*$v\*\*" "$f" || die "$f does not state 'Library version is **$v**'"
  done
  echo "shim-release: $dir carries $tag; both SOURCE.md state $v"
}

usage() {
  echo "usage: scripts/shim-release.sh version | archive <arch> | pin <tag> | fetch [dir] | verify [dir]" >&2
  exit 2
}

case "${1:-}" in
  version) [ $# -eq 1 ] || usage; version ;;
  archive) [ $# -eq 2 ] || usage; archive "$2" ;;
  pin) [ $# -eq 2 ] || usage; pin "$2" ;;
  fetch) [ $# -le 2 ] || usage; fetch "${2:-dist/shim}" ;;
  verify) [ $# -le 2 ] || usage; verify "${2:-$TREE}" ;;
  *) usage ;;
esac
