# Pulse shim 0.2.6

Purpose-driven `libpulse.so.0` for Spotify Soloist on Volumio 4.

Soloist has no ALSA backend. It `dlopen`s this name and looks up the 47
`pa_*` symbols in [ABI.txt](ABI.txt). This library implements those symbols
and writes the client format (FLOAT32) into `plug:volumio`. The outer
`plug:` converts to whatever the slave opens. It is not apulse, not a
Pulse server, and not a general
PulseAudio replacement.

Runtime link is `libasound` and libc only. `libpulse-simple` and
`libpulse-mainloop-glib` are not built.

## Version

CMake `VERSION` is 0.2.6. `SOVERSION` is 0 so the soname stays
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

- writei the client spec (FLOAT32 at the client rate). Do not pick S16
  or S32: on volumioswitch that becomes the USB/AML open and rushes.
  The `plug:` in `plug:volumio` is the converter. Exact rate or fail;
  never `set_rate_near` onto 48 k / 88.2 k. I/O is capped at two
  periods so switcher `avail` is not treated as the DAC. Packed
  S24_3LE is never the client format. Bit-perfect is not possible.
- Played time is `write_index` minus ring fill minus `snd_pcm_delay` on
  the PCM we opened. `/proc/asound` is not scanned for some other card.
- `pa_stream_write` takes a prefix if the ring cannot hold the whole
  buffer. Soloist always writes 32 KiB and will not uncork if that call
  fails, so rejecting a short write deadlocks preroll (0.2.1 on hanger).
  The ring is `tlength` plus 64 KiB so a default 500 ms cap does not
  drop the tail of that write (0.2.4 on Rivo/Integro).
- On the first `pa_*` call, `--api-key` on argv is overwritten with
  `nice-try-logsubmit` so `ps` and logsubmit do not publish the secret.
- Pulse `tlength` / `minreq` pace Soloist. The ALSA period is chosen with
  `snd_pcm_hw_params_set_period_size_near`.
- Cork keeps the PCM. Close only when the yield file appears or the stream
  disconnects. `snd_pcm_close` is never run from the I/O callback.
- Flush drops and re-prepares a healthy handle. If `prepare` leaves
  `avail` dead, or drop/prepare fails, the handle is abandoned on the
  close worker and a new `plug:volumio` is opened after that close
  finishes. Later flush on that stream reopens instead of drop.
- `pa_context_connect` sets CONNECTING then READY in the same call.
- The ring is sized in time at the client's frame size.
  `pa_stream_writable_size` is the room left against `tlength`.
- An xrun is `snd_pcm_prepare` with the playhead held, not a close.
  `prepare` plus a still-dead `avail` is a dead switcher target: reopen,
  deferred off the I/O callback.

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
