#!/bin/bash
# Launcher for the Soloist daemon on Volumio 4.
# Reads settings from /data/soloist/soloist.env (written by the plugin).
# Routes audio through the private apulse shim onto pcm.volumio.
# Handles the glibc sideload when the system glibc is older than Soloist.
set -e

ENV_FILE="/data/soloist/soloist.env"
PLUGIN_DIR="/data/plugins/music_service/soloist_connect"
BIN="/data/soloist/bin/soloist"
if [ ! -x "$BIN" ]; then
  BIN="$PLUGIN_DIR/bin/soloist"
fi
SYSROOT="/data/soloist/sysroot"
PATCHELF="/usr/bin/patchelf"
[ -x "$PATCHELF" ] || PATCHELF="$(command -v patchelf || true)"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE - save the plugin settings in Volumio first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [ -z "$API_KEY" ]; then
  echo "API_KEY is empty - set it in the plugin settings." >&2
  exit 1
fi

# Do not put the sideloaded glibc on LD_LIBRARY_PATH in this shell.
# On a 64-bit Pi that briefly had an armhf sysroot, bash/patchelf then
# load 32-bit libc and die ("symbol lookup error ... libc.so.6").
unset LD_LIBRARY_PATH

APULSE_ARCH="$("$PLUGIN_DIR/detect-arch.sh")"
APULSE_DIR="$PLUGIN_DIR/alsa-lib/$APULSE_ARCH"
if [ ! -f "$APULSE_DIR/libpulse.so.0" ]; then
  echo "apulse shim missing at $APULSE_DIR (userspace $APULSE_ARCH, uname=$(uname -m))." >&2
  exit 1
fi

export APULSE_PLAYBACK_DEVICE="${APULSE_PLAYBACK_DEVICE:-plug:volumio}"
unset PULSE_SERVER
unset PIPEWIRE_RUNTIME_DIR
echo "SoloistConnect: userspace=$APULSE_ARCH device=$APULSE_PLAYBACK_DEVICE uname=$(uname -m)" >&2

# writeEnvFile() always emits API_KEY, DEVICE_NAME, INITIAL_VOLUME and
# CACHE_SIZE, and validates them before writing. No conditional assembly here.
ARGS=(
  --device-name "$DEVICE_NAME"
  --api-key "$API_KEY"
  --data-dir /data/soloist/data
  --cache-dir /data/soloist/cache
  --ws 127.0.0.1:9878
  --initial-volume "$INITIAL_VOLUME"
  --cache-size "$CACHE_SIZE"
)
[ "$VERBOSE" = "true" ] && ARGS+=(--verbose)

if [ -d "$SYSROOT" ]; then
  INTERP=$("$PATCHELF" --print-interpreter "$BIN" 2>/dev/null || true)
  echo "SoloistConnect: interpreter=${INTERP:-unknown}" >&2
  case "$INTERP" in
    "$SYSROOT"*)
      ;;
    *)
      if [ -w "$BIN" ]; then
        echo "SoloistConnect: binary not patched; trying patch-soloist.sh" >&2
        bash "$PLUGIN_DIR/patch-soloist.sh" "$BIN"
        INTERP=$("$PATCHELF" --print-interpreter "$BIN" 2>/dev/null || true)
      fi
      case "$INTERP" in
        "$SYSROOT"*)
          ;;
        *)
          echo "soloist binary is not ELF-patched against $SYSROOT." >&2
          echo "interpreter was: ${INTERP:-unknown}" >&2
          echo "Run: sudo /bin/bash $PLUGIN_DIR/download-soloist.sh" >&2
          exit 1
          ;;
      esac
      ;;
  esac
fi

# apulse only. Soloist's RPATH already points at the sideloaded glibc.
# Putting sysroot on LD_LIBRARY_PATH here would poison nothing (we exec),
# but keep it off so a mistaken wrapper cannot break 64-bit helpers.
exec env LD_LIBRARY_PATH="$APULSE_DIR" \
  "$BIN" "${ARGS[@]}"
