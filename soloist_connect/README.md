# Spotify Soloist Connect

> **Alpha, version 0.6.12.**
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
| Cache location | Disk | Where downloaded audio is kept. **Disk** puts it on the data partition, where it survives a reboot. **RAM** keeps it in memory, which takes cache writes off a slow SD card, but costs that much memory and is emptied on every reboot and plugin restart. A lossless track is roughly 44 MB. Only worth choosing on a board with memory to spare; on a 512 MB board such as a Pi Zero 2 W it is a large share of the total, and the size is capped accordingly. |
| Output buffer (ms) | 500 | 100 to 2000. How much audio is buffered ahead of the DAC. Lower responds faster to skip, seek and pause; too low risks dropouts. |
| Output trim (dB) | 0 | -12 to +12. A fixed gain on the Spotify stream before it reaches the ALSA chain. Use it if this source arrives quieter or louder than the rest of the system. It does not move the volume knob. |
| Verbose logging | off | Logs every event Spotify sends the device, and turns on the audio shim's own diagnostics: device lifecycle, per-second write counters, and what the shim does when ALSA reports a fault. Useful when reporting a problem; noisy, so leave it off otherwise. It changes no playback behaviour. |

The settings page also has an **update** button, which fetches a fresh Soloist build from Spotify and restarts the daemon.

---

## How the audio path works

```
Spotify app  ->  soloist daemon  ->  Pulse shim  ->  pcm.volumio  ->  AAMPP / DSP  ->  DAC
```

Soloist has no ALSA backend of its own; it speaks PipeWire or PulseAudio.
The plugin ships a private Pulse shim (`libpulse.so.0`) that implements the PulseAudio client calls Soloist uses, and points Soloist at it.
No PulseAudio daemon is installed, and nothing else on the system is changed.

Sample rate and quality shown in the Volumio UI are worked out on the device.
Soloist does not report either, so the sample rate comes from the open ALSA stream and the quality tier is measured from the downloaded track: its size against its duration gives the bitrate, which maps onto Spotify's own tiers.
Rapid skipping produces no measurement, so the last known tier stays on screen rather than being replaced by a guess.

### Sharing the output with other sources

The device is held only while Spotify is playing.

Pausing in the Spotify app keeps it, so resuming is instant.
Starting anything else in Volumio, a local album, a web radio, another plugin, takes it: Spotify pauses and the new source plays.

The player stays in the Spotify app's device list throughout.
Switching source in Volumio does not end the Connect session, so pressing play on the phone again brings it straight back without re-selecting the device.

### Volume

When Volumio has a mixer, hardware or software, that mixer does the attenuation and the Spotify app's slider moves it.
The stream itself stays at full scale, which is what VU meters and other per-source metering need: the needles follow the music rather than the volume knob.

With the mixer set to `None` there is nothing downstream to attenuate, so the volume is applied to the stream instead.

**Output trim** is separate from all of this. It is a fixed offset on the stream itself, applied before the ALSA chain, and it is the right control when this source is simply quieter or louder than everything else on the system. Because the stream normally arrives at full scale, a trim is also what changes how far VU meters swing on Spotify without touching any other source. Around +6 dB is a reasonable starting point if the needles sit at half height.

### VU meters

If you use the PeppyMeter screensaver, turn its Spotify metering on there and the meters will follow Spotify.
There is no switch for it in this plugin: the screensaver owns the setting and this plugin follows it, whichever of the two you set up first.

Metering routes the audio through the screensaver's own point in the chain, which is below FusionDSP and Stylish Player, so those are bypassed while it is on. The screensaver already refuses to enable Spotify metering when DSP is in use.

### Do not run the stock Spotify plugin as well

Volumio's own Spotify Connect plugin and this one are two versions of the same thing, and they compete for the same audio path.
Enable one or the other. The plugin warns you if it finds both running.

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

**Lossless needs a moment at the start of a track.**
At lossless the plugin buffers half a second of audio before the DAC, which is why skip and seek take longer there than at the lossy tiers.

**The Soloist binary is not part of this package.**
It is downloaded from Spotify's official CDN during install, because Spotify does not permit redistributing it.

**A RAM cache is emptied on every restart.**
That is what it is: memory, not storage. Saving settings restarts the daemon, so the cache is discarded then too, and the next track is downloaded again. It is worth choosing when the boot medium is slow, not otherwise.

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

Turn on **Verbose logging** first when investigating playback problems. Without it the audio shim is silent about what it does when ALSA reports a fault, and the log shows the symptom with nothing on either side of it. The startup line states which mode it is in:

```
SoloistConnect: userspace=armhf device=plug:volumio ... diag=1
```

The journal on Volumio is held in memory and is destroyed by a reboot. Capture it before restarting:

```
journalctl -b -u soloist -u volumio --no-pager > /data/soloist-report.txt
```

Confirm the ALSA device exists:

```
aplay -L | grep volumio
```

Common cases:

- **Nothing plays and the log shows exit code 10.** The Soloist build expired. Press the update button in the plugin settings.
- **The device does not appear in the Spotify app.** Check that the API key was saved, that the daemon is running, and that the device and phone are on the same network segment.
- **Another source will not start while Spotify is connected.** Should not happen from 0.4.0 onwards. If it does, `journalctl -u volumio -f | grep -i soloist` around the moment you switch will show whether the device was released.
- **Install failed with "Pulse shim ... is not in the plugin package".** The package was built without the libraries for this architecture. Report it, including the architecture reported by `dpkg --print-architecture`.

When reporting a problem, **never post your API key, unredacted logs, crash reports or the contents of `/data/soloist`.**
Redact before sharing.

---

## Licence and attribution

This plugin is MIT licensed. See [LICENSE](LICENSE).
The Pulse shim that plays through `pcm.volumio` is this project's own code, shipped as `alsa-lib/<arch>/libpulse.so.0`.

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
