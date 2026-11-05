# Changelog

All notable changes to the Pulse shim, `libpulse.so.0` for Spotify Soloist on ALSA. The format follows Keep a Changelog; versions follow Semantic Versioning. Each version is a release `shim-v<version>` on this repository; the Volumio plugin pins one of them and has its own changelog.

## [0.2.13] - 2026-11-05, pre-release

- **A delay that rose is a card still playing.** `snd_pcm_delay` is a pointer estimate and can step up by a frame or two on a hardware card that is consuming; 0.2.12 read any figure that had not fallen as the stuck plugin and ended the spell early, a smaller form of the cork it had just removed. Only a figure exactly where it was is stuck now; a risen one is waited out like a fallen one, and the cap of twice the buffer still ends a figure that only climbs. Found in review of 0.2.12 before anyone heard it.

## [0.2.12] - 2026-11-05, pre-release

- **The dry-spell check waits out a device that is still playing.** 0.2.11 decided at a fixed bound and so told Soloist the stream was dry whenever the device was still running at that moment, audio or not; and it waited a whole buffer before even looking at a device that had reported zero delay. Now each wait is what the device says it still holds plus the margin, zero included; a device still running whose delay is smaller than at the last look is consuming and is waited out; only an unmoved delay is called stuck; a device that will not say gets the whole buffer; no spell lasts longer than twice the buffer. The dead-device recovery takes the same once-per-spell latch, so a check already armed cannot report a second underflow behind it. Found in review of 0.2.11 before any confirmation on the reporters' hardware.

## [0.2.11] - 2026-11-05, pre-release

- **One underflow per dry spell, on every device.** When the ring runs dry the library now reports an underflow to Soloist once ALSA has played out what it held: the remaining delay, or the whole buffer when the device will not say, plus a margin. A device that has stopped, reports nothing left, or still claims to be running once that bound has passed, is dry. The next write that queues data ends the spell, as does flush; nothing is reported while corked or without a PCM. Before, a dry ring only parked the output; a Soloist that saw the stream drained mid-track and was never told underflow stopped feeding and never came back, the PCM left `PREPARED`. Reported by ludoo on piCorePlayer with a `plughw` device in issue 1; the notification is the second half of the patch he posted there.
- **A poll error is an underrun, recovered as one.** An error the poll reports on the PCM descriptor, which is how a hardware PCM announces an underrun, now goes through the same recovery as any other: the played position sampled, the clock frozen, one prepare, a line in the diag. Before, the mainloop prepared the device itself without a word, so the recovery, the diagnostic and the underflow all missed it.
- **No yield unless asked.** With `APULSE_YIELD_PATH` unset the PCM stays open until Soloist disconnects. Before, the library fell back to a path from one host's layout and looked for it on every wakeup.
- Two unlimited diagnostic lines: `ring dry` with the device state, delay and the bound chosen, and `underflow` with the time it took.
- The archive carries `LICENSE`.

## [0.2.10] - 2026-11-04

- **A finished frame is reported exactly, including the last one.** Played, frozen and held positions are kept in client bytes instead of passing through microseconds and back, which left the read index one frame short of the write index at 440 of every 441 positions at 44.1 kHz; Soloist waited for that frame at the end of every stream. Reported with a patch by ludoo on piCorePlayer, confirmed on moOde by felipec84, issue 1.
- Active underrun recovery takes its snapshot of played bytes before preparing the PCM and freezing the clock, so it no longer holds a stale position.
- Opt-in regression tests (`BUILD_TESTING=ON`): completion, lifecycle, precision, drain.

## [0.2.9] - 2026-08-25

- The library the Volumio plugin shipped from 0.8.4 to 0.9.5. Built by CI as `shim-v0.2.9` on 2026-11-04, byte for byte the same.
