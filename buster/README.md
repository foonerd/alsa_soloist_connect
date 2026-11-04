# The Volumio 3 (buster) build

Best effort. The plugin's main line is `soloist_connect/`, for Volumio 4 on Debian bookworm. This directory is everything that makes the Volumio 3 (Debian buster) build different, kept apart so that neither build mentions the other. The directory, the packaging target and the zip suffix are all named after the OS codename, as Volumio's own repositories are.

## Policy

- The build is offered as-is. The author has no Volumio 3 device and does not work on that line beyond keeping the build assembling and the files in this directory in step with the main tree.
- It is not submitted to any plugin store. It is published as `soloist_connect-<version>-buster.zip` on the GitHub release, as a pre-release that is never promoted to latest.
- Community reports on the forum thread are the only test. A buster-only defect with no community fix offered stays open.
- The main line is never changed for the sake of this build.

## What is here

`plugin/` holds whole files that replace their namesakes in `soloist_connect/` when the buster zip is assembled:

| File | Why it differs |
| --- | --- |
| `package.json` | `os` is buster, `engines` are Node 14 and Volumio 3, the store text names Volumio 3. The version and the changelog line are the same as in the main `package.json`, written by hand, in lock step: `scripts/check.sh` and `scripts/package.sh` refuse a mismatch. |
| `README.md` | The user README for a Volumio 3 player. |
| `install.sh` | No apt at all. buster's apt has no patchelf, and the sideloaded sysroot already carries libatomic. |
| `setup-glibc.sh` | Sideloads patchelf into the private sysroot the same way as the glibc, because buster's apt has none. Never runs apt. |
| `download-soloist.sh`, `patch-soloist.sh`, `launch-soloist.sh` | Look for patchelf in the sysroot's bin when the system has none. |
| `alsa-lib/SOURCE.md` | The shim provenance, naming the build container by Debian version number. |

Everything else, `index.js` included, is the main tree unchanged. The plugin's code runs on Node 14; the test suite is run on Node 14 and on Node 20 by CI, so a change on the main line that needs a newer Node fails there before it reaches a buster player.

`BASE` records the commit of the main tree the files in `plugin/` were last reconciled with. `scripts/check.sh` lists every namesake that changed since, so drift is visible; reconciling is a hand job, as it should be.

## How the zip is built

```
scripts/package.sh buster
```

The script stages `soloist_connect/` as committed, lays `plugin/` over it, refuses to continue if the two `package.json` versions differ, and refuses to zip a tree that contains the words "Volumio 4" or "bookworm" anywhere. The main zip is refused in the same way for "Volumio 3" and "buster". The zip holds that tree and nothing else: no `node_modules`, no lockfile. The release workflow does the same on a tag.

## Installing on a Volumio 3 player

Download the `-buster` zip from the release page, then on the player:

```
mkdir -p /home/volumio/soloist_connect
cd /home/volumio/soloist_connect
miniunzip /home/volumio/soloist_connect-<version>-buster.zip
volumio plugin install
```

The player's helper installs the plugin's dependencies itself, as for any plugin folder. To update, uninstall from the Volumio UI first, then install the new zip the same way.

## Reporting

The forum thread for the plugin. Say that it is the Volumio 3 build, give the Volumio version, the board, and `journalctl -u soloist -u volumio --no-pager` with the API key redacted.
