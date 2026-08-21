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

[foonerd/apulse](https://github.com/foonerd/apulse) at
`112ef02300c10f40daf63b2d5ebfeb710dcec6e2`.

That is a fork of [i-rinat/apulse](https://github.com/i-rinat/apulse) at
`5d654cecd18474b4e0d885e774bc41fcbbc9818b`, with the Volumio changes as commits
on `master`. Upstream is unchanged and still reachable:

```
git log --oneline 5d654ce..112ef02
```

shows exactly what was added, and each commit carries its evidence in its
message: the device captures, the disassembly, the arithmetic.

These were a patch series until the stack reached eight files. Every
consolidation shifted the next patch's line numbers, and a hand-edited hunk
header twice cost a build by silently dropping the hunks after it. Git maintains
the arithmetic now.

Four of the eight are upstream defects rather than Volumio policy: a
use-after-free on context teardown, a narrowing `g_memdup`, a `pa_stream_flush`
that discarded nothing alongside an io callback that spun on a level-triggered
`POLLOUT`, and a `read_index` that collapsed to zero whenever the clock stopped.
`git format-patch 5d654ce..HEAD` produces those for submission.

The repository and commit are pinned in `docker/run-docker-apulse.sh`, which
passes both into the container, and mirrored as fallbacks in
`scripts/build-apulse.sh`. Keep the two in agreement: when only the build script
was updated to point at the fork, the runner's values won and a build produced
stock upstream while every gate passed.

The build refuses to proceed if the checked-out tree has no commits on top of
`5d654ce`, which is what caught that.

Override for testing:

```
APULSE_REF=<sha> ./docker/run-docker-apulse.sh amd64
APULSE_REPO=https://github.com/i-rinat/apulse.git APULSE_REF=5d654ce ./docker/run-docker-apulse.sh amd64
```

The second builds stock upstream, which the commit check rejects. That is
intentional.

License: MIT (apulse). The fork adds no different terms.
