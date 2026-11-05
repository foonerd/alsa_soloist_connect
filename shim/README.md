# Pulse shim 0.2.11

One `libpulse.so.0` for Spotify Soloist on ALSA.

Soloist has no ALSA backend. It `dlopen`s `libpulse.so.0` and looks up the
48 `pa_*` names in [ABI.txt](ABI.txt). This library implements those names
over ALSA and nothing else. It is not apulse, not a Pulse server and not a
general PulseAudio replacement. `libpulse-simple` and
`libpulse-mainloop-glib` are not built. Runtime link is `libasound` and
libc only. Licence is MIT. Soloist itself is not part of it; each host
fetches Soloist from Spotify.

## Contract

This is what a packager gets, on any ALSA system.

### The surface

The names in [ABI.txt](ABI.txt), taken from Soloist 1.3.7, are the whole
surface. Soloist builds through 1.3.10, the ones running on hosts other
than the one this library was written for, load it. A later Soloist that
looks up a name not in the list fails at startup, and that name is the
only reason the list grows.

### What you pin

A release is a tag `shim-v<version>` on this repository, built by CI from
that commit. The artefact is `soloist-shim-<version>-<arch>.tar.gz`, one
per userspace: `amd64`, `arm64`, `armhf`, matched to the Soloist binary,
not the kernel. Each archive holds `libpulse.so.0`, `SOURCE_REVISION`
(the commit it was built from) and `LICENSE`; `SHA256SUMS` on the release
page carries the digests. The soname is `libpulse.so.0` and does not
change. Your version of this library is the tag plus `SOURCE_REVISION`;
the version of any host that consumes it is not.

The library must not be installed as the system `libpulse.so.0`. It
replaces PulseAudio's client library for one process, Soloist, through
`LD_PRELOAD` or `LD_LIBRARY_PATH`, from a directory of your choosing.

### Environment

Your unit owns the device name, the Soloist download and the service. The
library reads these variables; the names are historical.

| Variable | Meaning | Unset |
|---|---|---|
| `APULSE_PLAYBACK_DEVICE` | the ALSA device string: `plughw:CARD=…,DEV=0`, a `plug:` over your chain, `default` | `plug:volumio`; set it |
| `APULSE_YIELD_PATH` | the PCM is closed when this file appears and reopened when it is gone, for a host that hands the device to another player | no yield: the PCM stays open until Soloist disconnects |
| `APULSE_MAX_TLENGTH_MS` | a cap on the Pulse `tlength` Soloist asks for | Soloist's own buffer stands |
| `APULSE_EXTERNAL_VOLUME` | `1`: do not scale samples, a mixer or the DAC owns the fader | this library scales the samples to the Connect volume |
| `APULSE_OUTPUT_TRIM_DB` | a fixed gain offset applied before the ALSA write | none |
| `APULSE_DIAG` | diagnostic lines on stderr, prefixed `soloist-shim:`; hot entry points log their first eight calls then one suppression line, every other line is unlimited | quiet |

### What the library guarantees on every device

Soloist sees one Pulse stream and does not know whether the descriptor
underneath is a kernel PCM or an ioplug. The behaviour it can rely on is
the same for both.

- The open format is the client format at the client rate. Exact rate or
  the open fails. A `plug:` in the device string is the converter; this
  library does not pick S16 or S32 and does not `set_rate_near`.
- The played position is in client bytes: `write_index` minus the ring
  minus `snd_pcm_delay` on the PCM this library opened. A finished frame,
  including the last frame of a stream, is reported exactly. The read
  index never goes backwards.
- One underflow per dry spell, when the ring is empty and the device holds
  nothing, including a dry spell the poll descriptor never reports. The
  check is made once ALSA has had time to play out what it held, the
  remaining delay or the whole buffer plus a margin; a device that still
  claims to be running after that is dry. The next write that queues data
  ends the spell, as does flush. A poll error on the descriptor goes
  through the same recovery as any underrun: position sampled, clock
  frozen, one prepare, a line in the diag. The next unpaused write
  restarts a `PREPARED` device.
- `pa_stream_write` accepts a short prefix when the ring cannot take the
  whole buffer. Soloist writes 32 KiB and will not uncork if the call
  fails.
- Cork keeps the PCM and feeds silence while it runs. Flush drops the
  ring and keeps the handle. The PCM is closed only on yield or
  disconnect, never from the I/O callback.
- While running, one wakeup writes at most two periods.
- `--api-key` on Soloist's command line is overwritten two seconds after
  load, and on the first `pa_*` call, so `ps` and log uploads do not show
  the secret.

### What this library is not

A request for exclusive `hw:`, no float, no plug, no resampling, DSD, or a
second client is not another symbol and not another host. Soloist hands
this library a Pulse stream; the library writes that stream's format at
that stream's rate, and `plug` converts to what the card opens. A DAC
showing 44100 Hz `S24_LE` under a FLOAT32 stream is `plughw` converting.
Bit-perfect from Spotify is not available on this path. The controls that
do belong to the host are the device string and `APULSE_EXTERNAL_VOLUME`.
A request that needs a Pulse server or a bit-perfect hop is a different
product.

## Installing on any Linux

```sh
cd ~
curl -LO https://github.com/foonerd/alsa_soloist_connect/releases/download/shim-v0.2.11/soloist-shim-0.2.11-arm64.tar.gz
curl -LO https://github.com/foonerd/alsa_soloist_connect/releases/download/shim-v0.2.11/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
mkdir -p ~/soloist-shim && tar -C ~/soloist-shim -xzf soloist-shim-0.2.11-arm64.tar.gz
```

Pick the archive for the Soloist binary: `file $(command -v soloist)` says
`aarch64` for `arm64`, `ARM, EABI5` for `armhf`, `x86-64` for `amd64`.

Soloist `dlopen`s `libpulse.so.0` by name. Put the directory on the
library path when you start it, or preload the file, which loads it at
exec:

```sh
LD_LIBRARY_PATH=~/soloist-shim APULSE_PLAYBACK_DEVICE=plughw:CARD=X,DEV=0 soloist …
# or
LD_PRELOAD=~/soloist-shim/libpulse.so.0 APULSE_PLAYBACK_DEVICE=plughw:CARD=X,DEV=0 soloist …
```

Under systemd, the same as `Environment=` lines in a drop-in for the
Soloist unit. The library prints no version of its own; confirm what is
loaded with

```sh
pid=$(pidof soloist); grep libpulse /proc/$pid/maps | head -1
cat ~/soloist-shim/SOURCE_REVISION
```

To capture a fault, start Soloist with `-v` and `APULSE_DIAG=1` and keep
the thirty seconds before the event: Soloist's own lines and the
`soloist-shim:` lines interleave on stderr.

## Version

CMake `VERSION` is 0.2.11. `SOVERSION` is 0 so the soname stays
`libpulse.so.0`. The source lives in this repository and `SOURCE_REVISION`
is the git commit that produced each `.so`. Changes are in
[CHANGELOG.md](CHANGELOG.md).

## Releases

A tag `shim-v<version>` on this repository runs
`.github/workflows/shim-release.yml`: the three architectures are built
from that commit in Debian 12 containers, each library passes the ldd
gate and the tests, and one GitHub release carries the three archives
with their digests in `SHA256SUMS`. The tag must name the `VERSION` above
and the heading of this file. A release is published as a pre-release and
promoted by hand once it has been confirmed on a hardware PCM and on an
ioplug chain.

```sh
scripts/shim-release.sh archive amd64
```

writes the same archive from `out/amd64/` after a workstation build, for a
commit with a clean `shim/`.

## Build

From the repository root:

```sh
./build-matrix.sh
```

or one architecture:

```sh
./docker/run-docker-shim.sh amd64
```

Output is installed into `soloist_connect/alsa-lib/<arch>/`. Outside the
containers, plain CMake 3.13 or later with `libasound2-dev` builds it:

```sh
cmake -S shim -B build && cmake --build build
```

## Tests

Regression tests are opt-in (`BUILD_TESTING=ON`). Normal library builds
do not build test executables. To run them in a temporary directory
without changing a payload:

```sh
docker run --rm --network none -v "$PWD:/src:ro" soloist-shim-builder:amd64 \
  bash /src/scripts/check-shim.sh
```

Five groups: exact completion across formats, rates and channel counts;
the stream lifecycle (cork, flush, yield, reclaim, recovery); timing
precision; drain and recovery; and the dry spell (one underflow per
spell, on a stopped device, on a running device that reports nothing
left, on a running device past the bound, re-arm on write and flush,
nothing while corked or without a PCM, the poll-error recovery). They use
controlled ALSA responses without opening an audio device. CI runs them
in the same container on every push, and the shim release workflow runs
them for each architecture before it archives the library.

GNU AddressSanitizer builds use non-PIE linking for the test executable;
the shared library remains position-independent.

Related: [issue #1: tracks never end outside Volumio](https://github.com/foonerd/alsa_soloist_connect/issues/1).

## Notes from deployments

Why the guarantees above are shaped as they are. The devices named are
where each rule was learned; the rule holds everywhere.

- writei the client spec (FLOAT32 at the client rate). Do not pick S16
  or S32: on volumioswitch that becomes the USB/AML open and rushes.
  The `plug:` in `plug:volumio` is the converter. Exact rate or fail;
  never `set_rate_near` onto 48 k / 88.2 k. I/O is capped at two
  periods so switcher `avail` is not treated as the DAC. Packed
  S24_3LE is never the client format. Bit-perfect is not possible.
- Played time is `write_index` minus ring fill minus `snd_pcm_delay` on
  the PCM we opened. `/proc/asound` is not scanned for some other card.
- Played, frozen and held positions are counted in client bytes. Timing
  indices do not round-trip through microseconds; a completely played
  frame is reported exactly, including the final frame of a stream
  (0.2.10, issue 1: the microsecond round trip left the read index one
  frame short at 440 of every 441 positions at 44.1 kHz, and Soloist
  waited for that frame forever).
- Active XRUN recovery snapshots played bytes before preparing the PCM
  and freezing the clock. Ring-buffered data remains outstanding; paused
  streams and other recovery states retain their held positions.
- A dry ring is reported as one underflow once ALSA has played out
  (0.2.11, issue 1). Before, the ring running dry only parked the output,
  the mainloop prepared the underrun it then saw on the descriptor without
  a word, and a Soloist that had been told the stream was drained but
  never told underflow stopped feeding and never came back. On an ioplug
  that keeps claiming RUNNING with a stuck delay, the bound is what
  decides.
- `pa_stream_write` takes a prefix if the ring cannot hold the whole
  buffer. Soloist always writes 32 KiB and will not uncork if that call
  fails, so rejecting a short write deadlocks preroll (0.2.1).
  The ring is `tlength` plus 64 KiB so a default 500 ms cap does not
  drop the tail of that write (0.2.4 on Rivo/Integro).
- Two seconds after load, and on the first `pa_*` call, `--api-key` on
  argv is overwritten with `nice-try-logsubmit` so `ps` and logsubmit do
  not publish the secret. The constructor must not scrub: it runs before
  `main()` parses argv.
- Pulse `tlength` / `minreq` pace Soloist. The ALSA period is chosen with
  `snd_pcm_hw_params_set_period_size_near`.
- Cork keeps the PCM. Close only when the yield file appears or the stream
  disconnects. `snd_pcm_close` is never run from the I/O callback.
- Flush discards the Pulse ring and resets the write/read indices. It
  does not `snd_pcm_drop` or `prepare`. Drop on a healthy Motivo
  MultiRoom handle killed `volumioOutput` on the second seek. Committed
  ALSA audio plays out to the output-buffer bound. A dead handle
  (`drop_unsafe` or a hard `avail` error) still reopens.
- `pa_context_connect` sets CONNECTING then READY in the same call.
- The ring is sized in time at the client's frame size.
  `pa_stream_writable_size` is the room left against `tlength`.
- An xrun is `snd_pcm_prepare` with the playhead held, not a close.
  `prepare` plus a still-dead `avail` is a dead switcher target: reopen,
  deferred off the I/O callback.
