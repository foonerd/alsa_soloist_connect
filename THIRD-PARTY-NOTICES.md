# Third-party notices

This project aggregates third-party components.
It does not relicense, override or replace any of their terms.
Each component below keeps its own licence, and those terms govern that component.

The project's own code is MIT, Copyright (c) 2026 Just a nerd. See [LICENSE](LICENSE).

---

## Redistributed in this repository and in the plugin package

### apulse

- Upstream: https://github.com/i-rinat/apulse
- Licence: MIT
- Copyright (c) 2014-2018 Rinat Ibragimov
- Where: `soloist_connect/alsa-lib/{amd64,arm64,armhf}/`
- Full text: [`soloist_connect/alsa-lib/LICENSE.apulse`](soloist_connect/alsa-lib/LICENSE.apulse)

The pinned upstream revision that produced each shipped payload is recorded in
`soloist_connect/alsa-lib/<arch>/SOURCE_REVISION`, and the build recipe is in
`docker/` and `scripts/build-apulse.sh`.

### GLib and PCRE2 (statically linked into the apulse libraries)

- GLib: https://gitlab.gnome.org/GNOME/glib
- PCRE2: https://github.com/PCRE2Project/pcre2
- Licence: LGPL-2.1-or-later (GLib); PCRE2 is BSD-3-Clause, and the Debian
  `libpcre2-dev` archives used here are the upstream sources
- Reason: `libglib2.0` is not on a stock Volumio 4 image. The authority for the
  permitted runtime set is `volumio-os/recipes/base/VolumioBase.conf`, which
  lists `libasound2` but not glib.

LGPL-2.1 section 6 requires that a work using the library statically can be
relinked against a modified version of it.
That is satisfied here by publishing the complete build in this repository:

- `docker/Dockerfile.apulse.<arch>` fixes the Debian Bookworm base and the
  packages that supply `libglib-2.0.a` and `libpcre2-8.a`
- `scripts/build-apulse.sh` performs the clone at a pinned revision, the cmake
  configuration, and the link-line rewrite that pulls in the static archives
- `docker/run-docker-apulse.sh` and `build-matrix.sh` reproduce the build for
  any of the three architectures

Anyone can therefore substitute their own GLib, rerun the build, and obtain a
relinked `libpulse.so.0`.

### PulseAudio public headers

- Upstream: https://www.freedesktop.org/wiki/Software/PulseAudio/
- Licence: LGPL-2.1-or-later
- Copyright 2004-2006 Lennart Poettering; Copyright 2006 Pierre Ossman for Cendio AB
- Where: vendored inside the apulse source tree
  (`3rdparty/pulseaudio-headers/`) and used at build time only

apulse is an independent implementation of the PulseAudio client API.
No PulseAudio library code is redistributed here.

---

## Not redistributed, downloaded at install time

### Spotify Soloist

- Documentation: https://developer.spotify.com/documentation/soloist
- Downloads: https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates

The Soloist binary is **not** contained in this repository and **not** contained
in the plugin package.
`soloist_connect/download-soloist.sh` fetches it from Spotify's official CDN on
the device at install time, and the manual update button refetches it.
This is deliberate: Spotify's documentation states that Soloist archives and
binaries must not be redistributed, and that users should be linked to the
official downloads page instead.

Soloist is proprietary Spotify software, governed by the
[Spotify Terms and Conditions of Use](https://www.spotify.com/legal/end-user-agreement/)
and by Spotify's developer terms.
Soloist bundles open-source components of its own; see
[Soloist Third-Party Licenses](https://developer.spotify.com/third-party-licenses#soloist-third-party-licenses).

Each user must generate their own Soloist API key.
Keys must not be shared or redistributed.

### glibc sideload

On Debian Bookworm the system glibc is 2.36 and Soloist requires 2.38 or newer.
`soloist_connect/setup-glibc.sh` downloads `libc6`, `libgcc-s1`, `libstdc++6`
and `libatomic1` from the official Debian archive at install time and unpacks
them into a private sysroot under `/data/soloist/sysroot`.
Nothing from Debian is redistributed in this repository.
The system glibc is not modified.
glibc is LGPL-2.1-or-later; the other packages carry their own Debian terms.

---

## Trademarks

None of the marks below are owned by this project.
They are used descriptively, to identify the software this plugin works with.
No affiliation, endorsement or sponsorship is claimed or implied.

| Mark | Owner |
|---|---|
| Spotify, Spotify Connect, Spotify Soloist | Spotify AB |
| Volumio | Volumio SRL |
| Raspberry Pi | Raspberry Pi Ltd |
| Debian | Software in the Public Interest, Inc. |
| Linux | Linus Torvalds |

This project is an unofficial, community-built integration.
It is not affiliated with, endorsed by or sponsored by Spotify AB.
