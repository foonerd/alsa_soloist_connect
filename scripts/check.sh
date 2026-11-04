#!/bin/bash
# The workshop pass CI runs on the Node of each target: every script parses,
# every JSON file parses, every JavaScript file parses, the test suite passes,
# the two package.json files carry the same version and changelog line, and
# the buster overlay is compared with the main files it was taken from so
# drift is visible. Run it before a commit:
#
#   scripts/check.sh
set -euo pipefail
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"

echo "check: node $(node --version)"

echo "check: shell syntax"
for f in soloist_connect/*.sh buster/plugin/*.sh scripts/*.sh build-matrix.sh docker/*.sh; do
  bash -n "$f"
done

echo "check: json"
for f in soloist_connect/package.json soloist_connect/UIConfig.json soloist_connect/config.json \
         soloist_connect/i18n/*.json buster/plugin/package.json; do
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f"
done

echo "check: version lock step"
field() { node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))$2" "$1"; }
MAIN_VERSION=$(field "$ROOT/soloist_connect/package.json" .version)
BUSTER_VERSION=$(field "$ROOT/buster/plugin/package.json" .version)
if [ "$MAIN_VERSION" != "$BUSTER_VERSION" ]; then
  echo "  soloist_connect/package.json is $MAIN_VERSION, buster/plugin/package.json is $BUSTER_VERSION" >&2
  exit 1
fi
if [ "$(field "$ROOT/soloist_connect/package.json" .volumio_info.changelog)" != "$(field "$ROOT/buster/plugin/package.json" .volumio_info.changelog)" ]; then
  echo "  the changelog line differs between soloist_connect/package.json and buster/plugin/package.json" >&2
  exit 1
fi
echo "  both $MAIN_VERSION"

echo "check: javascript"
for f in soloist_connect/index.js soloist_connect/test/*.js; do
  node --check "$f"
done

echo "check: tests"
# The suite loads index.js, which needs the runtime dependencies. They are
# installed here for the test run only, into the gitignored node_modules of
# the working tree; nothing of this reaches a zip. --production is the
# spelling npm 6 (Node 14) and npm 10 (Node 20) both accept.
if [ ! -d soloist_connect/node_modules/kew ]; then
  ( cd soloist_connect && npm install --production --no-audit --no-fund --loglevel=error >/dev/null )
fi
( cd soloist_connect && node test/queue-mode.test.js | grep -v '^PASS ' )

echo "check: buster overlay against its base"
BASE=$(tr -d '[:space:]' < buster/BASE)
if git cat-file -e "$BASE^{commit}" 2>/dev/null; then
  drift=0
  while IFS= read -r f; do
    [ -e "soloist_connect/$f" ] || continue
    if ! git diff --quiet "$BASE" HEAD -- "soloist_connect/$f"; then
      echo "  soloist_connect/$f changed since $BASE; reconcile buster/plugin/$f"
      drift=1
    fi
  done < <(cd buster/plugin && find . -type f | sed 's|^\./||')
  [ "$drift" = 0 ] && echo "  no drift"
else
  echo "  base $BASE is not in this clone; skipped"
fi
