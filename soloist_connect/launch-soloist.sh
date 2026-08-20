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

# Diagnostic override. APULSE_DIR_OVERRIDE points the daemon at a different
# apulse build, which is how a trace build (WITH_TRACE=2, unstripped) is used
# without installing it into the plugin payload.
#
# It has to be an explicit variable: this script unsets LD_LIBRARY_PATH above,
# to keep the sideloaded 32-bit glibc away from bash and patchelf, and then sets
# it again on the exec line. Anything the caller exports is discarded in
# between, so passing LD_LIBRARY_PATH on the command line silently has no
# effect and the payload shim runs instead. That cost a capture.
if [ -n "${APULSE_DIR_OVERRIDE:-}" ]; then
  if [ ! -f "$APULSE_DIR_OVERRIDE/libpulse.so.0" ]; then
    echo "APULSE_DIR_OVERRIDE=$APULSE_DIR_OVERRIDE has no libpulse.so.0" >&2
    exit 1
  fi
  APULSE_DIR="$APULSE_DIR_OVERRIDE"
  echo "SoloistConnect: USING OVERRIDE SHIM $APULSE_DIR (diagnostic build)" >&2
fi

if [ ! -f "$APULSE_DIR/libpulse.so.0" ]; then
  echo "apulse shim missing at $APULSE_DIR (userspace $APULSE_ARCH, uname=$(uname -m))." >&2
  exit 1
fi

# pcm.volumio includes softvolume. LocalPlayback does not: it aborted
# in snd1_pcm_hw_param_get_min and left the DAC at full scale.
export APULSE_PLAYBACK_DEVICE="${APULSE_PLAYBACK_DEVICE:-plug:volumio}"
# One-shot close. Cork does not free the device; unsetVolatile/stop create
# this file and apulse closes on it, then unlinks.
export APULSE_YIELD_PATH="${APULSE_YIELD_PATH:-/data/soloist/alsa.yield}"
# Caps the buffer our patched apulse requests, and the Pulse latency it
# reports. volumioswitch delay is local + target and can sit at ~1.5 s
# even when the slider has already shrunk the hardware PCM. Unset or 0
# on an old env file would leave that uncapped.
case "${TLENGTH_MS:-}" in
  ''|0|*[!0-9]*) TLENGTH_MS=500 ;;
esac
export APULSE_MAX_TLENGTH_MS="$TLENGTH_MS"
# SoftMaster (or a hardware mixer) is the attenuator. Pulse sink-input
# volume still tracks the Connect slider; the shim must not multiply
# samples or peppyalsa sees the knob. Mixer type None leaves this unset
# so the shim remains the only gain.
if [ "${EXTERNAL_VOLUME:-}" = "true" ]; then
  export APULSE_EXTERNAL_VOLUME=1
else
  unset APULSE_EXTERNAL_VOLUME
fi
unset PULSE_SERVER
unset PIPEWIRE_RUNTIME_DIR
echo "SoloistConnect: userspace=$APULSE_ARCH device=$APULSE_PLAYBACK_DEVICE tlength_cap=${APULSE_MAX_TLENGTH_MS}ms external_volume=${EXTERNAL_VOLUME:-false} uname=$(uname -m)" >&2

# writeEnvFile() always emits API_KEY, DEVICE_NAME, INITIAL_VOLUME,
# CACHE_SIZE and EXTERNAL_VOLUME, and validates them before writing.
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
