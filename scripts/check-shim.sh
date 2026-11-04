#!/bin/bash
set -euo pipefail
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
cmake -S "$ROOT/shim" -B "$BUILD" -DBUILD_TESTING=ON "$@"
cmake --build "$BUILD" --parallel 2
ctest --test-dir "$BUILD" --output-on-failure