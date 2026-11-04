# Changelog

All notable changes to Spotify Soloist Connect are recorded here. The format follows Keep a Changelog; versions follow Semantic Versioning. From 0.9.3 each version is also assembled as a best effort Volumio 3 (buster) build, carrying the same version and the same changes; see `buster/README.md`.

## [0.9.6] - 2026-11-04

- **A track's end is reported exactly, so the next track starts on its own.** The Pulse shim moves to 0.2.10, release `shim-v0.2.10`. Played, frozen and held positions are kept in client bytes instead of passing through microseconds and back, which left the read index one frame short of the write index at the end of every stream; the daemon now sees its end-of-stream played out. Active underrun recovery takes its snapshot of played bytes before preparing the PCM and freezing the clock, so it no longer holds a stale position. With Soloist started by hand outside Volumio, a track could sit at its end forever and never advance; reported with a patch by ludoo on piCorePlayer and confirmed on moOde by felipec84 in issue 1. The shim's regression tests run in CI on every push and before every shim release.

## [0.9.5] - 2026-11-04

- **The Pulse shim ships from its own release line.** The library in `alsa-lib/` is release `shim-v0.2.9` of this repository, built by GitHub Actions from the same source and byte for byte the library shipped since 0.8.4. `alsa-lib/RELEASE` names the release and carries its digests, and every package is checked against it before it is published. Nothing changes on the player.

## [0.9.4] - 2026-11-04

- **An update brings the plugin back on its own.** Volumio stops a plugin before updating it and never starts it again; a toggle from the UI ran the previous version from memory, and a manual update left the daemon down. The installer now schedules a restart of the Volumio backend eight seconds after an update of an enabled plugin, so the new version starts and Spotify Connect returns without a toggle or a reboot. A first install is unchanged.
- **The sample rate with FusionDSP is the stream's own.** FusionDSP's ALSA hook publishes the parameters of the stream entering CamillaDSP; the plugin reads them while they are fresh instead of the `hw_params` below CamillaDSP, which showed CamillaDSP's output rate. Without FusionDSP, or with it disabled, nothing changes.

## [0.9.3] - 2026-11-04

- **The API key leaves the daemon's command line at start.** The launcher preloads the audio shim, so the shim's two-second scrub runs when Soloist starts, whether or not anything has played. Before, the shim loaded only at the first sound, and a daemon that had not played yet still showed the key to `ps` and to a log upload. Reported, with the fix, by chrisp429.
- **A Volumio 3 build.** The release workflow now assembles `soloist_connect-<version>-buster.zip` from the same source, with its own package metadata and install scripts, for Volumio 3 players. Best effort, community tested, not in the plugin store. The Volumio 4 plugin is unchanged by it.
- The plugin README no longer describes the Spotify Queue page as refreshing itself while open; that stopped in 0.9.2.

## [0.9.2] - 2026-10-26

- The Spotify Queue page is no longer pushed to every connected client after it is opened. It is a plain read, complete when opened; a change shows on the next open. A REST browse of `soloist_connect` has no side effects.

## [0.9.1] - 2026-09-25

- A Connect handover is claimed when `playing` arrives before `is_active`, within two seconds of `device_changed`. Submitted to the store on 2026-10-25.

## [0.9.0] - 2026-09-18

- Promoted to stable. The store listing carries armhf only.

## [0.8.9] - 2026-09-15

- Optional daily refresh of the Soloist binary before it expires.

## [0.8.8] - 2026-09-14

- Sound switch for Spotify's crossfade preferences.

## [0.8.7] - 2026-09-14

- Sound switch for Spotify's loudness normalization preferences.

## [0.8.6] - 2026-09-11

- Volumio is not claimed when Connect is playing elsewhere.

## [0.8.5] - 2026-09-02

- Named settings backups on the device.

## [0.8.4] - 2026-08-30

- Spotify is not paused after Connect leaves this speaker.

## [0.8.3] - 2026-08-30

- The quality tier is held while the cache file is still growing.

## [0.8.2] - 2026-08-28

- `soloist.service` is owned by the plugin only.

## [0.8.0] - 2026-08-25

- First beta, with a safe Soloist binary update.

## [0.7.6] - 2026-08-25

- The API key is overwritten on the daemon's command line two seconds after the shim loads.

## [0.7.5] - 2026-08-25

- Stock Spotify playlists are converted to Soloist rows.

## [0.7.4] - 2026-08-25

- Volumio's volume is aligned when Connect becomes active.

## [0.7.3] - 2026-08-25

- The open Spotify Queue tile followed Spotify's events. Superseded in 0.9.2.

## [0.7.2] - 2026-08-24

- The Spotify Queue tile is hidden when queue playback is off.

## [0.7.1] - 2026-08-24

- Spotify's Connect queue on a Browse tile.

## [0.7.0] - 2026-08-24

- Spotify tracks play from a Volumio mixed list.

## [0.6.x] - 2026-08-18 to 2026-08-23

- The in-tree Pulse shim replaces apulse; the ALSA write path, buffering, seek and yield behaviour settled on the shipping shim 0.2.x; the API key hidden from `ps` after the first Pulse call.
