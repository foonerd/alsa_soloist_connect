#!/bin/bash
# Assemble a plugin zip: the plugin tree as it is in git, nothing added.
#
#   scripts/package.sh [bookworm|buster]
#
# bookworm, the default: soloist_connect/ as it is, the Volumio 4 main line.
# buster: soloist_connect/ with buster/plugin/ laid over it, the best effort
# Volumio 3 build. The two package.json files carry the version and the
# changelog line by hand, in lock step; a mismatch stops the build here.
#
# The zip holds exactly what `volumio plugin install` consumes on a player:
# the plugin folder with package.json at its root. No node_modules, no
# package-lock.json, no build metadata. The player's own helper installs the
# dependencies, as it does for the git and zip installs in the README and for
# the store submission, where the same helper packages on the device.
#
# A tree that names the other target does not ship: the bookworm zip may not
# say "Volumio 3" or "buster" anywhere, the buster zip may not say "Volumio 4"
# or "bookworm". The store's own submit rejects an os list that is not the
# submitting device's codename, so this separation is a store rule.
# Output: dist/soloist_connect-<version>.zip or
# dist/soloist_connect-<version>-buster.zip.
set -euo pipefail
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
TARGET=${1:-bookworm}
NAME=soloist_connect

case "$TARGET" in
  bookworm) SUFFIX="" ;;
  buster) SUFFIX="-buster" ;;
  *) echo "package: unknown target '$TARGET' (bookworm or buster)" >&2; exit 2 ;;
esac

field() { node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))$2" "$1"; }

STAGE=$ROOT/dist/stage/$NAME
rm -rf "$ROOT/dist/stage"
mkdir -p "$STAGE" "$ROOT/dist"

# The committed plugin tree only: what git holds at HEAD, not what a
# workstation left in the working tree. The version is read from that tree.
git -C "$ROOT" archive --format=tar HEAD "$NAME" | tar -C "$ROOT/dist/stage" -xf -
VERSION=$(field "$STAGE/package.json" .version)
MAIN_CHANGELOG=$(field "$STAGE/package.json" .volumio_info.changelog)

if [ "$TARGET" = buster ]; then
  git -C "$ROOT" archive --format=tar HEAD buster/plugin | tar -C "$ROOT/dist/stage" -xf -
  OVERLAY=$ROOT/dist/stage/buster/plugin
  OVER_VERSION=$(field "$OVERLAY/package.json" .version)
  if [ "$OVER_VERSION" != "$VERSION" ]; then
    echo "package: buster/plugin/package.json carries $OVER_VERSION, soloist_connect/package.json carries $VERSION; the versions are lock step, fix the overlay" >&2
    exit 1
  fi
  if [ "$(field "$OVERLAY/package.json" .volumio_info.changelog)" != "$MAIN_CHANGELOG" ]; then
    echo "package: the changelog line in buster/plugin/package.json differs from soloist_connect/package.json; the two are lock step, fix the overlay" >&2
    exit 1
  fi
  tar -C "$OVERLAY" -cf - . | tar -C "$STAGE" -xf -
  rm -rf "$ROOT/dist/stage/buster"
fi

# The other target's name must not appear anywhere in this tree.
case "$TARGET" in
  bookworm) FORBIDDEN='volumio ?3\b|volumio3|buster' ;;
  buster) FORBIDDEN='volumio ?4\b|volumio4|bookworm' ;;
esac
if grep -rIl -i -E "$FORBIDDEN" "$STAGE" >/dev/null; then
  echo "package: the $TARGET tree names the other target; not shipping:" >&2
  grep -rIn -i -E "$FORBIDDEN" "$STAGE" >&2
  exit 1
fi

# What the store's submit checks of package.json, checked here first.
node -e '
  const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const fail = (m) => { console.error("package: package.json: " + m); process.exit(1); };
  for (const k of ["name", "version", "description", "author", "license", "repository"]) if (!p[k]) fail("missing " + k);
  if (!/^\d+\.\d+\.\d+$/.test(p.version)) fail("version must be three numbers: " + p.version);
  const v = p.volumio_info || {};
  if (!v.prettyName || !v.plugin_type || !v.icon || !v.details) fail("volumio_info needs prettyName, plugin_type, icon, details");
  for (const a of v.architectures || []) if (!["amd64", "armhf", "i386"].includes(a)) fail("architecture " + a + " is not accepted by the store");
  if (!Array.isArray(v.os) || v.os.length !== 1 || v.os[0] !== process.argv[2]) fail("os must be exactly [\"" + process.argv[2] + "\"], the submitting device codename; got " + JSON.stringify(v.os));
  if (!p.engines || !p.engines.node || !p.engines.volumio) fail("engines.node and engines.volumio are required");
' "$STAGE/package.json" "$TARGET"

ZIP=$ROOT/dist/$NAME-$VERSION$SUFFIX.zip
rm -f "$ZIP"
( cd "$STAGE" && zip -qr "$ZIP" . )
rm -rf "$ROOT/dist/stage"
echo "package: $ZIP: $(stat -c %s "$ZIP") bytes, sha256 $(sha256sum "$ZIP" | cut -d' ' -f1)"
