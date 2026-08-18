# Spotify Soloist Connect

> **Alpha, version 0.3.0.**
> This plugin is under active development and is not ready for general use.
> Expect rough edges, and see "Things to know" below.

Turns a Volumio 4 device into a Spotify Connect endpoint using Spotify Soloist.

Audio plays through `pcm.volumio`, so Volumio's volume control, DSP and the rest of the AAMPP chain all apply.
There is no PulseAudio daemon and no PipeWire on the device.

Track metadata, cover art and transport controls sync into the Volumio UI.
Works on Raspberry Pi and on x86.

**This is an unofficial, community-built plugin. It is not affiliated with, endorsed by or sponsored by Spotify AB.**

---

## Before you install

You need a Spotify account with **Premium** to generate a Soloist API key.
Once the plugin is running, both Free and Premium accounts can connect to it from the Spotify app.

You also need the device to reach Spotify's CDN, because the Soloist binary is downloaded on install rather than bundled.

---

## Setup

1. Install the plugin. It is not in the Volumio plugin store yet; install the alpha package supplied to you.
2. Log in to the [Spotify for Developers dashboard](https://developer.spotify.com/dashboard) and generate a key on the [Spotify Soloist API Key](https://developer.spotify.com/dashboard/soloist) page.
3. Open the plugin settings, paste the key, set a device name, and save.
4. Open the Spotify app on the same network and pick the device.

The plugin starts without a key so that the settings page can be opened.
The Soloist daemon starts once a key has been saved.

Treat the API key as a secret.
It belongs to the account that generated it and must not be shared.

---

## Settings

| Setting | Default | Notes |
|---|---|---|
| API key | empty | From the Spotify for Developers dashboard. Stored on the device with mode 0600. |
| Device name | `Volumio` | The name shown in the Spotify app. |
| Initial volume | 50 | 0 to 100. |
| Cache size (MB) | 1024 | `0` means no limit. Other values must be 100 or more. |
| Output buffer (ms) | 500 | 100 to 2000. How much audio is buffered ahead of the DAC. Lower responds faster to skip, seek and pause; too low risks dropouts. |
| Verbose logging | off | Adds verbose logging to the daemon. Useful when reporting a problem. |

The settings page also has an **update** button, which fetches a fresh Soloist build from Spotify and restarts the daemon.

---

## How the audio path works

```
Spotify app  ->  soloist daemon  ->  apulse  ->  pcm.volumio  ->  AAMPP / DSP  ->  DAC
```

Soloist has no ALSA backend of its own; it speaks PipeWire or PulseAudio.
The plugin ships a private copy of **apulse**, which implements the PulseAudio client API on top of ALSA, and points Soloist at it.
No PulseAudio daemon is installed, and nothing else on the system is changed.

Sample rate and bit depth shown in the Volumio UI are read from the open ALSA playback stream, because the Soloist API does not report them.

---

## Supported devices

| Device | Supported |
|---|---|
| Raspberry Pi 2 and later, 32-bit or 64-bit userspace | yes |
| x86 / x86_64 | yes |
| Raspberry Pi 1, Pi Zero v1 (armv6) | no, Soloist has no armv6 build |

Volumio 4 (Debian Bookworm base) is required.

---

## Things to know

**Soloist builds expire after 90 days.**
This is a Spotify design decision, not a plugin limitation.
The plugin checks on start and re-downloads automatically, and there is a manual update button.
A device left powered off past the expiry will refresh on its next start, provided it can reach the internet.

**Skip and seek are not instant.**
Volumio's ALSA chain buffers audio ahead of the DAC, and it applies the Output Buffer setting twice, so the delay is roughly double the value you set.
Lowering the setting shortens it; too low risks dropouts on a busy device.
A residual delay remains at any setting, because the audio already sent downstream is played out rather than discarded.

**The Soloist binary is not part of this package.**
It is downloaded from Spotify's official CDN during install, because Spotify does not permit redistributing it.

---

## Troubleshooting

Check the daemon:

```
journalctl -u soloist -f
```

Check the plugin:

```
journalctl -u volumio -f | grep -i soloist
```

Confirm the ALSA device exists:

```
aplay -L | grep volumio
```

Common cases:

- **Nothing plays and the log shows exit code 10.** The Soloist build expired. Press the update button in the plugin settings.
- **The device does not appear in the Spotify app.** Check that the API key was saved, that the daemon is running, and that the device and phone are on the same network segment.
- **Install failed with "apulse shim missing".** The package was built without the libraries for this architecture. Report it, including the architecture reported by `dpkg --print-architecture`.

When reporting a problem, **never post your API key, unredacted logs, crash reports or the contents of `/data/soloist`.**
Redact before sharing.

---

## Licence and attribution

This plugin is MIT licensed. See [LICENSE](LICENSE).

It includes **apulse** by Rinat Ibragimov, MIT licensed.
The licence text ships alongside the libraries in [`alsa-lib/LICENSE.apulse`](alsa-lib/LICENSE.apulse).
Those libraries statically link GLib and PCRE2, which are LGPL-2.1-or-later and BSD-3-Clause respectively; the full notice and the means to rebuild and relink them are published in the project repository.

Using Spotify Soloist means accepting the [Spotify Terms and Conditions of Use](https://www.spotify.com/legal/end-user-agreement/).
Soloist is proprietary Spotify software and is downloaded from Spotify, not supplied by this plugin.

Spotify, Spotify Connect and Spotify Soloist are trademarks of Spotify AB.
Volumio is a trademark of Volumio SRL.
Raspberry Pi is a trademark of Raspberry Pi Ltd.
These marks are used descriptively only.

---

## Source and support

Source, build system and full third-party notices:
https://github.com/foonerd/alsa_soloist_connect

Report plugin problems there.
Problems with Soloist itself, or with Spotify accounts and playback, belong with Spotify; the project repository lists where each one goes.

---

## Credits

- [wheaten](https://github.com/wheaten/) started this work.
- [nerd](https://github.com/foonerd/) took it over and carried it to the Volumio 4 ALSA path.
