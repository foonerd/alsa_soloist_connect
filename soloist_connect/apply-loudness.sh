#!/bin/bash
# Merge audio.normalize_v2 into Soloist's data-dir prefs before spawn.
# Called from launch-soloist.sh as volumio. Never fails the launch.
#
# The engine has no CLI or WebSocket for this key. It reads the desktop-client
# prefs store at startup. Per-user files override the global store per key, so
# both are updated when they exist. Other lines are left alone.

DATA_DIR="${SOLOIST_DATA_DIR:-/data/soloist/data}"
KEY="audio.normalize_v2"

case "${LOUDNESS_NORMALIZATION:-}" in
  true) WANT=true; LABEL=on ;;
  false) WANT=false; LABEL=off ;;
  *) WANT=true; LABEL=on ;;
esac

STORES=0

merge_one() {
  local dest="$1"
  local dir tmp line
  dir=$(dirname "$dest")
  if ! mkdir -p "$dir"; then
    echo "SoloistConnect: loudness_normalization: cannot create $dir" >&2
    return 1
  fi
  tmp="$dest.tmp.$$"
  {
    if [ -f "$dest" ]; then
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
          "$KEY"=*) continue ;;
        esac
        printf '%s\n' "$line"
      done < "$dest"
    fi
    printf '%s\n' "$KEY=$WANT"
  } > "$tmp" || {
    rm -f "$tmp"
    echo "SoloistConnect: loudness_normalization: cannot write $tmp" >&2
    return 1
  }
  if ! mv -f "$tmp" "$dest"; then
    rm -f "$tmp"
    echo "SoloistConnect: loudness_normalization: cannot replace $dest" >&2
    return 1
  fi
  return 0
}

if merge_one "$DATA_DIR/settings/prefs"; then
  STORES=$((STORES + 1))
fi

USERS="$DATA_DIR/settings/Users"
if [ -d "$USERS" ]; then
  for user_dir in "$USERS"/*; do
    [ -d "$user_dir" ] || continue
    [ -f "$user_dir/prefs" ] || continue
    if merge_one "$user_dir/prefs"; then
      STORES=$((STORES + 1))
    fi
  done
fi

echo "SoloistConnect: loudness_normalization=$LABEL stores=$STORES" >&2
exit 0
