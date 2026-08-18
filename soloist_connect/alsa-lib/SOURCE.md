# apulse Pulse-to-ALSA shim

Pre-built shared objects per architecture. Soloist only speaks PipeWire or
PulseAudio. These libraries implement that client API on ALSA, so the
daemon can play into `pcm.volumio` on Volumio 4 (no Pulse daemon).

## Layout

- **amd64/** — x86_64
- **arm64/** — aarch64 (64-bit Pi)
- **armhf/** — armv7l (32-bit Pi)

Each directory must contain:

- `libpulse.so.0`
- `libpulse-simple.so.0`
- `libpulse-mainloop-glib.so.0`

`install.sh` and `launch-soloist.sh` pick the directory from `detect-arch.sh`
(userspace arch, not kernel `uname -m`).

## How they are built

From the `alsa_soloist_connect` folder, on a machine with Docker:

```
./build-matrix.sh
cp -a out/amd64/. soloist_connect/alsa-lib/amd64/
cp -a out/arm64/. soloist_connect/alsa-lib/arm64/
cp -a out/armhf/. soloist_connect/alsa-lib/armhf/
```

Single arch:

```
./docker/run-docker-apulse.sh amd64
```

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
