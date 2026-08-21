# Third-party notices

This project aggregates third-party components.
It does not relicense, override or replace any of their terms.
Each component below keeps its own licence, and those terms govern that component.

The project's own code is MIT, Copyright (c) 2026 Just a nerd. See [LICENSE](LICENSE).
That includes the Pulse shim in [`shim/`](shim/) and the shipped
`libpulse.so.0` under `soloist_connect/alsa-lib/`.

---

## Redistributed in this repository and in the plugin package

### PulseAudio public headers

- Upstream: https://www.freedesktop.org/wiki/Software/PulseAudio/
- Licence: LGPL-2.1-or-later
- Copyright 2004-2006 Lennart Poettering; Copyright 2006 Pierre Ossman for Cendio AB
- Where: [`shim/include/pulse/`](shim/include/pulse/), used at build time only

The shim is an independent implementation of the PulseAudio client symbols
Soloist looks up. No PulseAudio library code is redistributed. The shipped
`libpulse.so.0` is this project's MIT code.

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
