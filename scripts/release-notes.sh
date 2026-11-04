#!/bin/bash
# Print the changelog section of one version, for the release notes.
set -euo pipefail
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
VERSION=${1:?version, such as 0.9.3}
awk -v v="$VERSION" '
  /^## \[/ { if (found) exit; if (index($0, "## [" v "]") == 1) { found = 1; next } }
  found { print }
' "$ROOT/CHANGELOG.md" | sed -e '1{/^$/d}' -e '${/^$/d}'
