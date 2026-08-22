# Pulse shim 0.2.1

Purpose-driven `libpulse.so.0` for Spotify Soloist on Volumio 4.

Soloist has no ALSA backend. It `dlopen`s this name and looks up the 47
`pa_*` symbols in [ABI.txt](ABI.txt). This library implements those symbols
and writes integer PCM (S16, then S32, never packed S24) into
`plug:volumio`. It is not apulse, not a Pulse server, and not a general
PulseAudio replacement.

Runtime link is `libasound` and libc only. `libpulse-simple` and
`libpulse-mainloop-glib` are not built.

## Version

CMake `VERSION` is 0.2.1. `SOVERSION` is 0 so the soname stays
`libpulse.so.0`. There is no tag pin: the source lives in this repository
and `SOURCE_REVISION` is the git HEAD that produced each shipped `.so`.

## Build

From the repository root:

```
./build-matrix.sh
```

or one architecture:

```
./docker/run-docker-shim.sh amd64
```

Output is installed into `soloist_connect/alsa-lib/<arch>/`.

## Playback contract

- Convert client FLOAT32 to S16_LE (then S32_LE) in the shim and write
  that. `pcm.softvolume` is not assumed to exist; Rivo's chain has no
  softvolume. Packed S24_3LE is never opened: plug accepts it and
  volumioswitch then dies. Bit-perfect is not possible.
- Played time is `write_index` minus ring fill minus `snd_pcm_delay` on
  the PCM we opened. `/proc/asound` is not scanned for some other card.
- `pa_stream_write` is all-or-nothing. A write larger than
  `writable_size` is rejected and the caller keeps the buffer.
- Pulse `tlength` / `minreq` pace Soloist. The ALSA period is chosen with
  `snd_pcm_hw_params_set_period_size_near`.
- Cork keeps the PCM. Close only when the yield file appears or the stream
  disconnects. `snd_pcm_close` is never run from the I/O callback.
- `pa_context_connect` sets CONNECTING then READY in the same call.
- The ring is sized in time at the client's frame size.
  `pa_stream_writable_size` is the room left against `tlength`.
- An xrun is `snd_pcm_prepare` with the playhead held, not a close.

## Environment

Launcher names are historical (`APULSE_*`). The shim still reads them:

| Variable | Role |
|---|---|
| `APULSE_PLAYBACK_DEVICE` | ALSA device, default `plug:volumio` |
| `APULSE_YIELD_PATH` | close the PCM when this file appears |
| `APULSE_MAX_TLENGTH_MS` | cap on Pulse `tlength` |
| `APULSE_EXTERNAL_VOLUME` | do not scale samples; Volumio's mixer does |
| `APULSE_OUTPUT_TRIM_DB` | fixed stream offset before the ALSA write |
| `APULSE_DIAG` | diagnostic lines on stderr (plugin Verbose logging). Hot `pa_*` entry points, including `pa_threaded_mainloop_wait`, log the first eight calls then one suppression line. |
