# apulse Pulse-to-ALSA shim

Pre-built shared objects per architecture. Soloist only speaks PipeWire or
PulseAudio. These libraries implement that client API on ALSA, so the
daemon can play into `pcm.volumio` on Volumio 4 (no Pulse daemon).

## Layout

- **amd64/** — x86_64
- **arm64/** — aarch64 (64-bit Pi)
- **armhf/** — armv7l (32-bit Pi)

Each directory contains exactly these files, and nothing else:

- `libpulse.so.0`
- `libpulse-simple.so.0`
- `libpulse-mainloop-glib.so.0`
- `SOURCE_REVISION`

That list is the payload manifest. It is declared once, in
`docker/run-docker-apulse.sh` as `PAYLOAD_FILES`, and drives the copy, the
byte-for-byte verification and the removal of anything undeclared. Keep this
section and that array in agreement.

Upstream also builds an `apulse` launcher script. It is deliberately not shipped:
it hardcodes `/usr/local/lib/apulse`, which does not exist on Volumio, and
`launch-soloist.sh` sets `LD_LIBRARY_PATH` itself.

`install.sh` and `launch-soloist.sh` pick the directory from `detect-arch.sh`
(userspace arch, not kernel `uname -m`).

## How they are built

From the `alsa_soloist_connect` folder, on a machine with Docker:

```
./build-matrix.sh
```

Single arch:

```
./docker/run-docker-apulse.sh amd64
```

The build installs its own output into `soloist_connect/alsa-lib/<arch>/` and
verifies it byte-for-byte. There is no manual copy step: when there was one, a
stale shim shipped while the build log looked correct, and several rounds of
measurement were invalidated before anyone noticed. `out/<arch>/` is emptied at
the start of every build for the same reason.

The container is Debian Bookworm (Volumio 4's base). glib is statically
linked because `libglib2.0` is not in `VolumioBase.conf`. The build fails
if `ldd` shows anything other than `libasound` and the base libc family.

## Source

[i-rinat/apulse](https://github.com/i-rinat/apulse) at
`5d654cecd18474b4e0d885e774bc41fcbbc9818b`.

That revision is what `alsa-lib/{amd64,arm64,armhf}/` was built from.
`ldd` on each `libpulse.so.0` shows only `libasound.so.2` and the base
libc family.

Override the ref when testing:

```
APULSE_REF=master ./docker/run-docker-apulse.sh amd64
```

License: MIT (apulse)
