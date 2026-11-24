## Spotify Soloist Connect - stable

**Store: 0.9.11** (24 Nov 2026) - **Plugins -> Music Services** (armhf)

**GitHub (cutting edge): 0.9.11** (19 Nov 2026) - [repo](https://github.com/foonerd/alsa_soloist_connect)

Turns a Volumio 4 device into a Spotify Connect endpoint using Spotify Soloist.
Not affiliated with Spotify AB.

The store package is the accepted stable at **0.9.11**. Store and GitHub are the same build, shim **0.2.13**. The store listing is **armhf** only. x86 stays on GitHub (git sparse clone or `alsa_soloist_connect-main.zip`). Uninstall the store plugin before installing from GitHub.

From 0.9.3 the repo also assembles a **Volumio 3 (buster)** zip, `soloist_connect-<version>-buster.zip`, from the same source. Best effort, community tested, GitHub pre-release only, never in the store. The author has no Volumio 3 device. The Volumio 4 plugin is unchanged by it.

The Pulse shim has its own release line (`shim-v<version>`), its own changelog, and a README written for any ALSA host. piCorePlayer and moOde users are running it outside Volumio; their reports on issue 1 drove 0.9.6 through 0.9.9. 0.9.10 and 0.9.11 are the queue-mode fixes on Volumio. The shim stayed 0.2.13.

### Tested

Unchanged. These rows are **0.8.0** listens. **0.8.1** through **0.9.11** have no new pass/fail here. The x86 column is from those listens, not from the store zip.

|Plugin | x86 | rPi3 | rPi4 | rPi5 | PrimoV2 | Primo-Plus | Rivo | Motivo | Integro | Rivo+|
|--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---|
|**FusionDSP** | **Pass** | tbd | tbd | **Pass** | **Pass** | **Pass** | **Pass** | **Pass** | tbd | tbd|
|**Peppy Meter Basic** | **Pass** | tbd | tbd | **Pass** | n.a. | **Pass** | n.a. | **Fail** | n.a. | n.a.|
|**Peppy-Spectrum** | **Pass** | tbd | tbd | **Pass** | n.a. | **[Pass*](https://community.volumio.com/t/plugin-spotify-soloist-connect-for-volumio-incl-lossless/77256/57)** | n.a. | **Fail** | n.a. | n.a.|
|**Peppy/Spectrum for BW (exp. branch)** | **Pass** | tbd | tbd | **Pass** | tbd | tbd | tbd | **[Pass](https://community.volumio.com/t/plugin-spotify-soloist-connect-for-volumio-incl-lossless/77256/74)** | tbd | tbd|
|**Premium: Multiroom** | tbd | tbd | tbd | tbd | **Pass** | **Pass** | **Pass** | **Pass** | tbd | tbd|
| |  |  |  |  |  |  |  |  |  | |

### Known issues

| Issue | Note |
|---|---|
| Shim 0.2.13 | Shipping shim, store 0.9.11. Dry-spell handling was smoke tested with that build. If a track end hangs, or a track cuts early, report it with Verbose logging on: the `ring dry` and `underflow` lines say what the shim saw. |
| Soloist builds expire after 90 days | Spotify kills a build 90 days after its build date. That is their decision. On start the plugin re-downloads an already-dead build. While it stays up, a once-a-day check logs remaining days. **Download a new Soloist binary before it expires** is off by default. When on, that check pulls from Spotify if seven days or fewer remain, or the build is already dead, and Spotify is not playing here. Web radio and other sources count as idle. That silent pull starts the new binary and does not reboot. The Update button still uses a progress modal and a 15 second reboot countdown. We do not review the tarball Spotify serves. First check is a day after start, not at boot. |
| Loudness / crossfade are not a Soloist API | Soloist has no CLI or WebSocket for these. Official docs still say it does not read a configuration file. The Sound switches write `audio.normalize_v2` and `audio.crossfade_v2` / `audio.crossfade.time_v2` at spawn. Loudness is on by default. Crossfade is off; time is 1000-12000 ms and the time key is dropped when the switch is off. If a later Soloist build ignores or renames the keys, the switches still write and the audio may not change. Not Output Trim and not Output buffer. |
| Soloist response lag | 1-3 s on volume and skip. Spotify's binary, not the plugin. |
| arm64 | Built and shipped in the tree, not yet exercised at runtime. The store listing is armhf. |
| Queue playback | Off by default. `spop` rows are skipped at play time. **Convert playlist** can rewrite a saved list; it is not automatic. 0.9.10 keeps the list advancing after a row finishes. 0.9.11 does the same for Next. |
| Spotify Queue page does not refresh itself | By design from 0.9.2. Built once on open from a full `get_queue`; leave and re-open to see a change. A REST browse of `soloist_connect` has no side effects. |
| Updating the plugin restarts Volumio's backend | By design from 0.9.4. Volumio never starts a plugin again after an update, so the installer schedules a backend restart eight seconds after an update of an enabled plugin. The web UI reconnects within about half a minute. A first install does not restart anything. |

### Changelog

<details>
<summary><b>0.9.11</b> - 19 Nov 2026 - store from 24 Nov 2026</summary>

| Change | |
|---|---|
| Next stops the current service before core plays the following row. That stop forgot the row, so the pause Soloist sends for it arrived after the next row was armed and was taken as another session. Queue mode ended and the following Next sent `skip_next` and paused | Fixed |
| The row Next stops is remembered, the same way a row that plays to the end already is | Changed |
| A play of a different item still leaves queue mode | |
| Shim unchanged (0.2.13) | |
| Smoke tested. Submitted to the store as stable on 24 Nov 2026. Store listing is armhf. The device matrix above is still the 0.8.0 listens | |

</details>

<details>
<summary><b>0.9.10</b> - 18 Nov 2026</summary>

| Change | |
|---|---|
| After the first playlist row, Soloist's paused report for the finished track was compared with the next row and taken as another session. Queue mode ended and Spotify's queue owned every row after the first | Fixed |
| That paused tail is the remainder of the finished row and is ignored. A play of a different item still leaves queue mode | Changed |
| Shim unchanged (0.2.13) | |
| In the store as of 0.9.11 | |

</details>

<details>
<summary><b>0.9.9</b> - 5 Nov 2026 - store 06 Nov to 24 Nov 2026</summary>

| Change | |
|---|---|
| Shim 0.2.13. `snd_pcm_delay` is a pointer estimate and can step up by a frame or two on a hardware card that is consuming; 0.2.12 read any figure that had not fallen as a stuck software plugin and could report the card dry early | Fixed |
| Only a delay figure exactly where it was is stuck. A risen one is waited out like a fallen one; the cap of twice the buffer still ends a figure that only climbs | Changed |
| Found in review of 0.2.12 before anyone heard it. Smoke tested with 0.9.11 | |
| Plugin code unchanged from 0.9.6. Pin moves to `shim-v0.2.13` | |
| Submitted to the store as stable on 06 Nov 2026. Replaced in the store by 0.9.11 on 24 Nov 2026. Store listing is armhf. The device matrix above was not re-listened | |

</details>

<details>
<summary><b>0.9.8</b> - 5 Nov 2026</summary>

| Change | |
|---|---|
| Shim 0.2.12. 0.2.11 decided at a fixed moment and could report the card dry while it still held audio, and waited a whole buffer before looking at a card that had said it was empty | Fixed |
| Each wait is what the card says it still holds plus a margin, zero included. A running card whose delay shrank is consuming and is waited out; a card that will not say gets the whole buffer; no spell lasts longer than twice the buffer | Changed |
| The dead-device recovery takes the same once-per-spell latch, so an armed check cannot report a second underflow behind it | Changed |
| Found in review of 0.2.11 before any confirmation on the reporters' hardware | |
| Plugin code unchanged. Pin moves to `shim-v0.2.12` | |
| In the store as of 0.9.9 | |

</details>

<details>
<summary><b>0.9.7</b> - 5 Nov 2026</summary>

| Change | |
|---|---|
| Shim 0.2.11. When Soloist stopped writing for long enough that the card ran out, the shim told it all audio had played and never that it had run out; Soloist could wait forever with the card stopped (PCM left `PREPARED`) | Fixed |
| One underflow per dry spell, reported once ALSA has played out what it held, the way a PulseAudio server would. The next write that queues data, or a flush, ends the spell | Changed |
| An error the poll reports on the PCM descriptor (how a hardware PCM announces an underrun) goes through the same recovery as any other: position sampled, clock frozen, one prepare, a line in the diag. Before it was absorbed in silence | Fixed |
| With `APULSE_YIELD_PATH` unset the PCM stays open until Soloist disconnects. Volumio sets it; this is for other hosts | Changed |
| Two diagnostic lines: `ring dry` (device state, delay, bound chosen) and `underflow` (time it took) | New |
| Reported on piCorePlayer by ludoo in issue 1 after 0.2.10; the notification is the second half of the patch he posted there. Confirmed on the bench at a queue end on a hardware PCM; superseded by 0.9.8 before mid-track confirmation | |
| Shim README is now an adopter's guide for any ALSA host | |
| Plugin code unchanged. Pin moves to `shim-v0.2.11` | |
| In the store as of 0.9.9 | |

</details>

<details>
<summary><b>0.9.6</b> - 4 Nov 2026</summary>

| Change | |
|---|---|
| Shim 0.2.10. Played, frozen and held positions passed through microseconds and back, leaving the read index one frame short of the write index at 440 of every 441 positions at 44.1 kHz. Soloist waited for that frame at the end of every stream; started by hand outside Volumio, a track could sit at its end forever | Fixed |
| Positions are kept in client bytes. A track's end is reported exactly and the next track starts on its own | Changed |
| Active underrun recovery snapshots played bytes before preparing the PCM and freezing the clock, so it no longer holds a stale position | Fixed |
| Reported with a patch by ludoo on piCorePlayer, confirmed on moOde by felipec84, issue 1 | |
| Shim regression tests (completion, lifecycle, precision, drain) run in CI on every push and before every shim release | New |
| Plugin code unchanged. Pin moves to `shim-v0.2.10` | |
| In the store as of 0.9.9 | |

</details>

<details>
<summary><b>0.9.5</b> - 4 Nov 2026</summary>

| Change | |
|---|---|
| The Pulse shim ships from its own release line. `alsa-lib/` is release `shim-v0.2.9` of the repo, built by GitHub Actions from the same source, byte for byte the library shipped since 0.8.4 | Changed |
| `alsa-lib/RELEASE` names that release and its digests; every package is checked against it before publish | New |
| Nothing changes on the player | |
| Shim source moved to 0.2.10, not shipped here. Shipped from 0.9.6 | |
| In the store as of 0.9.9 | |

</details>

<details>
<summary><b>0.9.4</b> - 4 Nov 2026</summary>

| Change | |
|---|---|
| An update left the plugin stopped: Volumio stops a plugin before updating and never starts it again; a UI toggle ran the previous version from memory, a manual update left the daemon down | Fixed |
| The installer schedules a restart of the Volumio backend eight seconds after an update of an enabled plugin (transient systemd timer). The web UI reconnects within about half a minute. A first install does not restart anything | Changed |
| With FusionDSP in the chain the sample rate shown was CamillaDSP's output rate | Fixed |
| The plugin reads the stream parameters FusionDSP publishes at `hw_params` (`/tmp/fusiondsp_stream_params.log`) while fresh (15 s). Without FusionDSP, or with it disabled, nothing changes | Changed |
| Shim unchanged (0.2.9) | |
| In the store as of 0.9.9 | |

</details>

<details>
<summary><b>0.9.3</b> - 4 Nov 2026</summary>

| Change | |
|---|---|
| A daemon that had not played yet still showed the API key to `ps` and to a log upload. The shim, and its two-second scrub, loaded only at the first sound (seen on a Pi 3B+, armhf) | Fixed |
| The launcher preloads the shim (`LD_PRELOAD`), so the scrub runs at start whether or not anything has played. Soloist's later dlopen gets the same library; audio is unchanged | Changed |
| Reported, with the fix, by chrisp429. Tested on Volumio 3.912 / Pi 3B+. Not separately verified on Volumio 4. If a log with the key was posted, revoke the key on the Spotify dashboard | |
| A Volumio 3 (buster) build: `soloist_connect-<version>-buster.zip` from the same source, own package metadata and install scripts. Best effort, community tested, GitHub pre-release only, not in the store | New |
| Release train: GitHub Actions build one zip per target on a `v*` tag; the plugin tree as committed and nothing else. The release is created as a draft and published by hand after device checks | New |
| Plugin README no longer describes the Spotify Queue page as refreshing itself; that stopped in 0.9.2 | |
| Shim unchanged (0.2.9) | |
| In the store as of 0.9.9 | |

</details>

<details>
<summary><b>0.9.2</b> - 26 Oct 2026 - store 27 Oct to 06 Nov 2026</summary>

| Change | |
|---|---|
| After the Spotify Queue tile was opened, every `auth_state`, `track_changed` and `queue_changed` rebuilt the page and broadcast it (`pushBrowseLibrary`) to every connected client | Fixed |
| The page is a plain read. Built once on open from a full `get_queue` (the unsolicited event is capped at 10); a change shows on the next open | Changed |
| No `get_queue` is sent from `auth_state`, `track_changed` or `queue_changed`. Only an open asks | Changed |
| A REST browse of `soloist_connect` has no side effects | Changed |
| Playback, takeover and queue mode unchanged. Shim unchanged (0.2.9) | |
| Submitted to the store as stable on 27 Oct 2026 (store author metadata corrected the same day). Replaced in the store by 0.9.9 on 06 Nov 2026. Not listened | |

</details>

<details>
<summary><b>0.9.1</b> - 25 Sep 2026 - store 25 Oct to 27 Oct 2026</summary>

| Change | |
|---|---|
| Moving playback here while it is already playing stayed silent until Next. Soloist reported `playing` before `is_active` | Fixed |
| That refusal is remembered for 2 s and replayed from `device_changed` only | Changed |
| `auth_state`, queue mode, pause or idle, the 1.5 s yield window, and a later activation do not replay it | |
| Account `playing` with `is_active=false` still does not claim | |
| Shim unchanged (0.2.9) | |
| Submitted to the store as stable on 25 Oct 2026 (metadata only; code is the 25 Sep build). Replaced in the store by 0.9.2 on 27 Oct 2026. Not listened | |

</details>

<details>
<summary><b>0.9.0</b> - 18 Sep 2026 - store until 25 Oct 2026</summary>

| Change | |
|---|---|
| Promoted to stable. No longer beta | Changed |
| Store and GitHub were both 0.9.0. Store listing is armhf | |
| 0.8.6 through 0.8.9 are in this store package (takeover, loudness, crossfade, daily binary refresh) | |
| UI strings for every Volumio backend language_code | New |
| Shim unchanged (0.2.9) | |
| Replaced in the store by 0.9.1 on 25 Oct 2026 | |

</details>

<details>
<summary><b>0.8.9</b> - 15 Sep 2026</summary>

| Change | |
|---|---|
| Once-a-day Soloist binary freshness check while the plugin stays up | New |
| Switch Download a new Soloist binary before it expires (off by default) | New |
| When on, pull from Spotify if seven days or fewer remain, or the build is already dead, and Spotify is not playing here | Changed |
| That silent pull starts the new binary and does not reboot. The Update button still uses the 15 second reboot countdown | |
| On start an already-dead build is still re-downloaded. We do not review the tarball Spotify serves | |
| Crossfade, loudness, takeover, queue and the shim unchanged (0.2.9) | |
| In the store as of 0.9.0 | |

</details>

<details>
<summary><b>0.8.8</b> - 14 Sep 2026</summary>

| Change | |
|---|---|
| Sound switch Crossfade (off by default) plus 1000-12000 ms duration | New |
| Off drops the time key so a leftover fade cannot stay on | Changed |
| Same undocumented engine prefs pass as loudness. Not Output buffer | |
| If a later Soloist build ignores the keys, the switch still writes and the audio may not fade | |
| Takeover, queue, loudness default and the shim unchanged (0.2.9) | |
| In the store as of 0.9.0 | |

</details>

<details>
<summary><b>0.8.7</b> - 14 Sep 2026</summary>

| Change | |
|---|---|
| Sound switch Loudness normalization (on by default) | New |
| Off writes `audio.normalize_v2=false` at each spawn. Not Output Trim | Changed |
| No CLI for this; undocumented engine store | |
| If a later Soloist build ignores the key, the switch still writes and the level may not move | |
| Takeover, queue and the shim unchanged (0.2.9) | |
| In the store as of 0.9.0 | |

</details>

<details>
<summary><b>0.8.6</b> - 11 Sep 2026</summary>

| Change | |
|---|---|
| Daemon `playing` with `is_active=false` called `takeOverPlayback` / `volumioStop` on whoever was current, including AirPlay | Fixed |
| Connect mode does not claim unless this speaker is the Connect target. Status stays `pause` so a later play here still claims | Changed |
| Queue mode and leftover-yield play unchanged. Shim unchanged (0.2.9) | |
| In the store as of 0.9.0 | |

</details>

<details>
<summary><b>0.8.5</b> - 2 Sep 2026 - store until 18 Sep 2026</summary>

| Change | |
|---|---|
| Named settings backups on this device (create, restore, delete) | New |
| Restore uses the same validation as Save. The API key is in the file only when Retain my API key is on | Changed |
| A backup without a key keeps the key already on this box. Not a clone of the Spotify login | |
| After create, restore or delete the open settings page refreshes (`pushUiConfig`) | Changed |
| Playback, takeover unchanged. Shim unchanged (0.2.9) | |
| Replaced in the store by 0.9.0 on 18 Sep 2026 | |

</details>

<details>
<summary><b>0.8.4</b> - 30 Aug 2026</summary>

| Change | |
|---|---|
| After the session left this speaker, yield sent Spotify `pause` and stopped the phone or desktop | Fixed |
| Connect yield published `stop` while still volatile; core ignored it and the player / Peppy kept play | Fixed |
| Yield pauses only while this speaker still holds the session. Connect yield publishes `pause` while still volatile | Changed |
| Queue-row end still publishes `stop`. Takeover unchanged. Shim unchanged (0.2.9) | |
| In the store as of 0.8.5 | |

</details>

<details>
<summary><b>0.8.3</b> - 30 Aug 2026</summary>

| Change | |
|---|---|
| Skip before prefetch finished locked the quality line on Low (a few hundred KB over the track duration) | Fixed |
| Holds the label while that cache fd is still growing; publishes Lossless when the bitrate crosses the floor; upgrades if the same file gets larger | Changed |
| Disable/enable is not needed to show lossless. That remeasured the finished file | |
| Playback unchanged. Shim unchanged (0.2.9) | |
| In the store as of 0.8.5 | |

</details>

<details>
<summary><b>0.8.2</b> - 28 Aug 2026</summary>

| Change | |
|---|---|
| `soloist.service` could come back at boot with the plugin disabled (`WantedBy=multi-user.target`) | Fixed |
| Disable stops the daemon and unpins it from boot. Install no longer enables the unit | Changed |
| Playback unchanged. Shim unchanged (0.2.9) | |
| In the store as of 0.8.5 | |

</details>

<details>
<summary><b>0.8.1</b> - 27 Aug 2026</summary>

| Change | |
|---|---|
| Software mixer, `pcm.volumio` slave already `softvolume`: first play aborted (`pcm_params.c` `get_min`) on PCM2704 | Fixed |
| That graph now opens `softvolume` (SoftMaster stays). Peppy and switcher graphs stay on `plug:spotify` / `plug:volumio` | Changed |
| Start line always names `plugin=`, `shim=`, and the `.so` `SOURCE_REVISION` | New |
| In the store as of 0.8.5 | |

</details>

<details>
<summary><b>0.8.0</b> - 25 Aug 2026</summary>

| Change | |
|---|---|
| First beta | New |
| UI package is **Plugins -> Music Services**. GitHub is cutting edge between those releases | Changed |
| Updating the Soloist binary replaced the live file, then restarted the daemon in place | Fixed |
| Stage, patch and `--version` before replace. A failed download leaves the running binary | Changed |
| Settings button: system progress modal, then a 15 s reboot countdown with Restart and Cancel | Changed |
| Shim unchanged (0.2.9) | |

</details>

<details>
<summary><b>0.7.6</b> - 25 Aug 2026</summary>

| Change | |
|---|---|
| logsubmit / `ps` showed the Soloist API key on argv until the first Pulse call | Fixed |
| The shim overwrites that slot two seconds after load (and still on the first `pa_*` call) | Changed |
| Playback path unchanged | |
| Shim 0.2.9 | |
| The scrub ran only once the first sound loaded the shim. Moved to daemon start in 0.9.3 | |

</details>

<details>
<summary><b>0.7.5</b> - 25 Aug 2026</summary>

| Change | |
|---|---|
| Convert playlist: rewrite stock Spotify (`spop`) track rows in a saved Volumio list to `soloist_connect` | New |
| Clone is the default and leaves the original file; overwrite replaces it | |
| Only `spotify:track:` rows change. Album, playlist and artist URIs stay `spop` | |
| A list already saved as `soloist_connect` does not appear | |
| Does not restart Soloist and does not turn on queue playback | |
| Shim unchanged (0.2.8) | |

</details>

<details>
<summary><b>0.7.4</b> - 25 Aug 2026</summary>

| Change | |
|---|---|
| Optional Align volume on start (off by default) | New |
| When this speaker becomes the active Connect device, Volumio's volume is copied to Soloist instead of applying Initial Volume to the mixer | |
| Mute becomes 0; mixer None and disableVolumeControl skip align | |
| After that the Spotify app slider still moves the mixer | |
| Shim unchanged (0.2.8) | |

</details>

<details>
<summary><b>0.7.3</b> - 25 Aug 2026</summary>

| Change | |
|---|---|
| An open Spotify Queue tile was a snapshot from the moment it opened | Fixed |
| Now playing updates immediately; play next, up next, autoplay and recently played stay in those sections | Changed |
| Those lists are refilled with a full `get_queue` (the unsolicited event is capped at 10) | |
| Placeholder rows are omitted | Changed |
| Playback paths unchanged | |
| Shim unchanged (0.2.8) | |
| The live refresh added here is retired in 0.9.2 | |

</details>

<details>
<summary><b>0.7.2</b> - 24 Aug 2026</summary>

| Change | |
|---|---|
| Spotify Queue tile is registered only while Play Spotify tracks from the Volumio queue is on | Changed |
| Off hides it, so a tap cannot skip a row and stop Connect | Fixed |
| Saving that section adds or removes the tile without a daemon restart | |
| Shim unchanged (0.2.8) | |

</details>

<details>
<summary><b>0.7.1</b> - 24 Aug 2026</summary>

| Change | |
|---|---|
| Spotify Queue browse tile: now playing, play next, up next, autoplay, recently played | New |
| Source is `get_queue` / `queue_changed`. That is Spotify's Connect list, not Volumio's mixed playlist | |
| Tile appears when the Soloist socket is up; home icon is a sourceicon SVG | |
| Spotify Queue wait is a Timing setting (default 2500 ms, 0-10000; 0 paints the last event immediately) | New |
| Search is empty. Playback paths unchanged | |
| Shim unchanged (0.2.8) | |

</details>

<details>
<summary><b>0.7.0</b> - 24 Aug 2026</summary>

| Change | |
|---|---|
| Optional queue mode: a Spotify row in a Volumio playlist or queue can play through Soloist | New |
| Off by default. Needs a paired session (`logged_in`); the app does not have to be open | |
| No session, or another device holds it: the row is skipped and the list moves on | Changed |
| Remote-device play of a queued row is a separate switch, also off | New |
| Queue mode is not volatile: next/prev stay with core | Changed |
| Row ends on buffering-at-duration, idle after start, or a roll into autoplay; pause and ALSA yield before the next service | Changed |
| Settings split by change target. A section save posts only its fields | Changed |
| Daemon restarts only when it actually reads a changed value | Changed |
| Shim unchanged (0.2.8) | |

</details>

<details>
<summary><b>0.6.19</b> - 23 Aug 2026</summary>

| Change | |
|---|---|
| First pcm open on a busy card was a failed open | Fixed |
| Busy card is a wait; the first `pcm open` line is the success | Changed |
| Corked connect no longer opens the PCM | Changed |
| Tidal Connect (`vtcs`) is asked to release when it holds the DAC | New |
| Shim 0.2.8 | |

</details>

<details>
<summary><b>0.6.18</b> - 23 Aug 2026</summary>

| Change | |
|---|---|
| Peppy metering stored the flag but left the running process on `plug:volumio` after `pcm.spotify` appeared | Fixed |
| Restart only when the running process device does not match `plug:spotify` / `plug:volumio`. Unreadable environ is not a mismatch | Changed |
| Without Peppy the path is unchanged | |
| Shim unchanged (0.2.7) | |

</details>

<details>
<summary><b>0.6.17</b> - 23 Aug 2026</summary>

| Change | |
|---|---|
| Skip kept the previous track's quality label, or measured the last file against the new duration | Fixed |
| Quality retry wait and Quality retries are settings (defaults 300 ms and 2; 0 disables) | New |
| The playing cache file is not opened | Changed |
| Shim unchanged (0.2.7) | |

</details>

<details>
<summary><b>0.6.16</b> - 23 Aug 2026</summary>

| Change | |
|---|---|
| Flush discarded and re-prepared a healthy PCM; second Motivo MultiRoom seek killed volumioOutput | Fixed |
| Flush now drops the Pulse ring only; committed ALSA audio plays out | Changed |
| Seek coalesce and Inactive hold are settings (defaults 200 ms and 2000 ms; 0 disables) | New |
| Idle with an empty item published a blank now-playing line | Fixed |

</details>

<details>
<summary><b>0.6.15</b> - 23 Aug 2026</summary>

| Change | |
|---|---|
| If prepare left the switcher handle dead, flush now reopens instead of drop | Fixed |
| Healthy graphs still dropped and prepared on flush | Changed |

</details>

<details>
<summary><b>0.6.14</b> - 22 Aug 2026</summary>

| Change | |
|---|---|
| Default 500 ms buffer dropped the tail of Soloist's 8-32 KiB write (rush and chop) | Fixed |
| Ring is tlength plus 64 KiB; Pulse writable_size still reports the target | Changed |

</details>

<details>
<summary><b>0.6.13</b> - 22 Aug 2026</summary>

| Change | |
|---|---|
| Writes FLOAT32 at the client rate into plug:volumio; the outer plug converts | Changed |
| Forced S16 (0.6.10-0.6.12) set the USB/AML slave open and rushed | Fixed |
| Exact rate or fail; I/O capped at two periods | Changed |

</details>

<details>
<summary><b>0.6.12</b> - 22 Aug 2026</summary>

| Change | |
|---|---|
| `--api-key` and `API_KEY` no longer appear in `ps` or logsubmit | Fixed |

</details>

<details>
<summary><b>0.6.11</b> - 22 Aug 2026</summary>

| Change | |
|---|---|
| 32 KiB preroll write rejected when the ring had less room; device stayed silent | Fixed |

</details>

<details>
<summary><b>0.6.10</b> - 22 Aug 2026</summary>

| Change | |
|---|---|
| Shim converts FLOAT32 to S16 before writei | Changed |
| Times the PCM we opened; writes are all-or-nothing | Changed |

</details>

<details>
<summary><b>0.6.9</b> - 22 Aug 2026</summary>

| Change | |
|---|---|
| Reverts 0.6.4-0.6.8. Audio path is 0.6.3 again (FLOAT32 into plug:volumio) | Changed |
| Convert and pace matching snapped a 44.1 DAC to 88.2 k (half speed) | Fixed |

</details>

<details>
<summary><b>0.6.8</b> - 22 Aug 2026</summary>

| Change | |
|---|---|
| Ignore the first ALSA buffer before measuring pace; two agreeing 200 ms windows | Changed |
| 0.6.7 snapped a USB fill burst to 88.2 k and played 44.1 at half speed | Fixed |

</details>

<details>
<summary><b>0.6.7</b> - 22 Aug 2026</summary>

| Change | |
|---|---|
| Measure the consumer rate from frames versus wall time, including the poll wait | Changed |

</details>

<details>
<summary><b>0.6.6</b> - 22 Aug 2026</summary>

| Change | |
|---|---|
| Convert to the measured write pace when it is not the track rate | Changed |
| ALSA yield file left behind after a hand-off; next play had no PCM | Fixed |

</details>

<details>
<summary><b>0.6.5</b> - 22 Aug 2026</summary>

| Change | |
|---|---|
| 44.1 lossless played fast (Integro, with or without FusionDSP) | Fixed |
| ALSA resample on again; float-to-S24 convert unchanged | Changed |

</details>

<details>
<summary><b>0.6.4</b> - 22 Aug 2026</summary>

| Change | |
|---|---|
| Shim converts FLOAT32 to S24_3LE (or S24_LE / S16_LE) before writei | Changed |
| Exact sample rate; resample only if that open fails | Changed |
| Auto-advance showed the previous track's title | Fixed |

</details>

<details>
<summary><b>0.6.3</b> - 21 Aug 2026</summary>

| Change | |
|---|---|
| Replaced apulse with a purpose-built Pulse shim (47 symbols, ALSA only) | New |
| Quiet wait logs, and a `/proc` path overflow in the shim | Fixed |
| Retired the apulse build path | Changed |

</details>

<details>
<summary><b>0.6.2</b> - 21 Aug 2026</summary>

| Change | |
|---|---|
| Playback cache can be placed in RAM | New |
| Cache location selector, with the choice logged | Fixed |
| Metadata not shown when taking the session | Fixed |
| Diagnostics now follow the Verbose Logging setting | Changed |
| Removed `sed` from every executable path | Changed |

</details>

<details>
<summary><b>0.6.1</b> - 21 Aug 2026</summary>

| Change | |
|---|---|
| Verbose logging did nothing | Fixed |
| Seek bar: no per-second publish, which XRUN'd the DAC | Fixed |
| ALSA format and period negotiation | Fixed |
| Stale crashpad locks at every start | Fixed |
| Executable bit on the launcher | Fixed |

</details>

<details>
<summary><b>0.6.0</b> - 20 Aug 2026</summary>

| Change | |
|---|---|
| PeppyMeter / Spectrum screensaver support on Bookworm | New |
| Plays through the metered PCM when the screensaver asks | New |
| Implausible position timestamp rejected | Fixed |
| Seek timer no longer publishes; no yield on takeover | Fixed |

</details>

<details>
<summary><b>0.5.0</b> - 20 Aug 2026</summary>

| Change | |
|---|---|
| Output Trim, to set PeppyMeter needle deflection | New |

</details>

<details>
<summary><b>0.4.0</b> - 20 Aug 2026</summary>

| Change | |
|---|---|
| Meter deflection followed master volume | Fixed |
| Soloist not released after closing the Spotify app | Fixed |

</details>

<details>
<summary><b>0.3.0</b> - 18 Aug 2026</summary>

| Change | |
|---|---|
| Format negotiation | Fixed |
| Lagging response | Fixed |

</details>

<details>
<summary><b>Pre-alpha</b> - 17 Aug 2026</summary>

First working builds on rPi4, rPi5 and x86.
</details>
