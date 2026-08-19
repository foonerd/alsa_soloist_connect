'use strict';

const libQ = require('kew');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const WebSocket = require('ws');
const VConf = require('v-conf');

const SERVICE_UNIT = 'soloist.service';
const WS_HOST = '127.0.0.1';
const WS_PORT = 9878; // fixed local port for the Soloist WebSocket API
const ENV_FILE = '/data/soloist/soloist.env';
const CACHE_DIR = '/data/soloist/cache';

// Spotify's own quality tiers, from the app's audio quality menu:
//
//   Low        24 kbps
//   Normal     96 kbps
//   High      160 kbps
//   Very High 320 kbps
//   Lossless  FLAC, up to 24-bit/44.1 kHz
//
// Boundaries sit between the tiers rather than on them, so a track that
// compresses slightly under or over its target still lands in the right band.
// The lossless boundary is well clear: measured 1847 kbps on lossless against
// 338 on Very High.
const QUALITY_TIERS = [
  { max: 60, label: 'Low' },
  { max: 128, label: 'Normal' },
  { max: 240, label: 'High' },
  { max: 450, label: 'Very High' },
  { max: Infinity, label: 'Lossless' },
];
// data/cache dirs are fixed in launch-soloist.sh

module.exports = SoloistConnect;

function SoloistConnect(context) {
  this.context = context;
  this.commandRouter = context.coreCommand;
  this.logger = context.logger;
  this.configManager = context.configManager;
  this.servicename = 'soloist_connect';

  this.ws = null;
  this.wsReconnectTimer = null;
  this.active = false; // Soloist is the active Spotify Connect device
  this.activatedAt = 0; // when Soloist last became active
  this.lastPlayTransitionAt = 0; // when status last flipped to 'play'
  this.volatileSet = false;
  // Re-entry guard for state publication. servicePushState runs the whole
  // Volumio state chain synchronously; a nested publication would recurse until
  // the Socket.IO encoder blew the stack.
  this.publishing = false;
  this.ignoreStopEvent = false;
  this.state = this.emptyState();
  this.positionAnchor = { position_ms: 0, timestamp_ms: Date.now(), speed: 0 };
  this.seekTimer = null;
  this.pushStateTimer = null;
  this.pushStateDirty = false;
  this.volumeTimer = null;
  this.lastSentVolume = -1;
  this.volumeFromSoloist = false;
  this.quality = '';       // Spotify tier for the current track, '' until known
  this.qualityUri = '';    // track the last measurement was taken against
  this.qualityPath = '';   // cache file that track was reading from
  this.pendingYieldAt = 0; // yield in progress; leftover play must not reclaim
}

// ---------------------------------------------------------------------------
// Volumio lifecycle
// ---------------------------------------------------------------------------

SoloistConnect.prototype.onVolumioStart = function () {
  const configFile = this.commandRouter.pluginManager.getConfigurationFile(
    this.context,
    'config.json'
  );
  this.config = new VConf();
  this.config.loadFile(configFile);
  this.ensureConfigDefaults();
  this.restoreRetainedApiKey();
  return libQ.resolve();
};

// Uninstall deletes /data/configuration/music_service/soloist_connect wholesale
// (removePluginFromConfiguration runs rm -rf on it), so the API key cannot
// survive there. With "Retain my API key" on, uninstall.sh preserves
// /data/soloist/soloist.env and /data/soloist/data instead. On a fresh install
// the config has no key but the env file still does, so restore it.
//
// The env file is mode 0600 and owned by volumio, the same user this process
// runs as. Nothing is logged but the fact that a key was restored.
SoloistConnect.prototype.restoreRetainedApiKey = function () {
  if ((this.config.get('api_key') || '').trim()) return;

  let env;
  try {
    env = fs.readFileSync(ENV_FILE, 'utf8');
  } catch (e) {
    return; // no retained state, which is the normal first-install case
  }

  const m = env.match(/^API_KEY="((?:[^"\\]|\\.)*)"$/m);
  if (!m) return;

  const key = m[1].replace(/\\(.)/g, '$1').trim();
  if (!key) return;

  this.logger.info('SoloistConnect: restoring retained API key from ' + ENV_FILE);
  this.config.set('api_key', key);

  const name = env.match(/^DEVICE_NAME="((?:[^"\\]|\\.)*)"$/m);
  if (name) {
    const deviceName = name[1].replace(/\\(.)/g, '$1').trim();
    if (deviceName) this.config.set('device_name', deviceName);
  }
};

// Volumio copies the shipped config.json into /data/configuration only when no
// config exists there. On upgrade the stored config is kept as-is, so a setting
// added in a later version is absent and get() returns undefined, which reaches
// the env file as an empty value.
//
// requiredConf.json is not the answer: checkRequiredConfigurationParameters
// calls set() for every key on every plugin load, which would overwrite the
// user's value with the default at each boot. Seed only what is missing.
SoloistConnect.prototype.ensureConfigDefaults = function () {
  let defaults;
  try {
    defaults = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch (e) {
    this.logger.error('SoloistConnect: cannot read shipped config.json: ' + e.message);
    return;
  }

  for (const key of Object.keys(defaults)) {
    if (this.config.has(key)) continue;
    const spec = defaults[key];
    this.logger.info('SoloistConnect: adding missing config key ' + key + ' = ' + spec.value);
    this.config.addConfigValue(key, spec.type, spec.value);
  }
};

SoloistConnect.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

SoloistConnect.prototype.onStart = function () {
  const defer = libQ.defer();
  const self = this;

  if (!this.volumeCallbackRegistered) {
    this.commandRouter.addCallback('volumioupdatevolume', (vol) => {
      self.onVolumioVolume(vol);
    });
    this.volumeCallbackRegistered = true;
  }

  const apiKey = (this.config.get('api_key') || '').trim();
  if (!apiKey) {
    this.commandRouter.pushToastMessage(
      'info',
      'Spotify Soloist',
      'Please enter your Soloist API key in the plugin settings (Spotify for Developers dashboard).'
    );
    // Start "successfully" so the user can open settings; the daemon starts after saving.
    defer.resolve();
    return defer.promise;
  }

  this.startDaemon()
    .then(() => {
      self.connectWebSocket();
      defer.resolve();
    })
    .fail((e) => {
      self.logger.error('SoloistConnect: failed to start daemon: ' + e);
      defer.reject(e);
    });

  return defer.promise;
};

SoloistConnect.prototype.onStop = function () {
  const defer = libQ.defer();
  this.disconnectWebSocket();
  this.unsetVolatile();
  exec(`/usr/bin/sudo /bin/systemctl stop ${SERVICE_UNIT}`, () => defer.resolve());
  return defer.promise;
};

SoloistConnect.prototype.onRestart = function () {
  return this.onStop().then(() => this.onStart());
};

// ---------------------------------------------------------------------------
// Daemon management
// ---------------------------------------------------------------------------

SoloistConnect.prototype.pluginPath = function () {
  return '/data/plugins/music_service/soloist_connect';
};

SoloistConnect.prototype.binaryPath = function () {
  const staged = '/data/soloist/bin/soloist';
  if (fs.existsSync(staged)) return staged;
  return path.join(this.pluginPath(), 'bin', 'soloist');
};

SoloistConnect.prototype.runPath = function () {
  return this.binaryPath();
};

SoloistConnect.prototype.downloadScript = function () {
  return (
    '/usr/bin/sudo /bin/bash ' +
    path.join(this.pluginPath(), 'download-soloist.sh')
  );
};

SoloistConnect.prototype.startDaemon = function () {
  const defer = libQ.defer();
  const self = this;

  this.ensureBinaryFresh()
    .then(() => {
      self.writeEnvFile();
      exec(
        `/usr/bin/sudo /bin/systemctl restart ${SERVICE_UNIT}`,
        { timeout: 30000 },
        (error) => {
          if (error) {
            self.logger.error('SoloistConnect: systemctl restart failed: ' + error);
            self.commandRouter.pushToastMessage('error', 'Spotify Soloist', 'systemctl failed: ' + error);
            defer.reject(error);
          } else {
            self.logger.info('SoloistConnect: soloist daemon started');
            defer.resolve();
          }
        }
      );
    })
    .fail((e) => {
      const msg = (e && e.message) || String(e);
      self.logger.error('SoloistConnect: startDaemon pre-flight failed: ' + msg);
      self.commandRouter.pushToastMessage('error', 'Spotify Soloist', 'Startup failed: ' + msg);
      defer.reject(e);
    });

  return defer.promise;
};

// Soloist builds expire after 90 days (exit code 10). Check and re-download if
// needed. Fully async: a synchronous download here would block Volumio's event
// loop (and freeze the whole UI) for up to 5 minutes at boot.
SoloistConnect.prototype.ensureBinaryFresh = function () {
  const defer = libQ.defer();
  const self = this;
  const bin = this.binaryPath();

  const download = () => {
    exec(self.downloadScript(), { timeout: 300000 }, (error) => {
      if (error) defer.reject(error);
      else defer.resolve();
    });
  };

  if (!fs.existsSync(bin)) {
    download();
    return defer.promise;
  }

  exec(`${this.runPath()} --version`, { timeout: 15000 }, (error) => {
    if (error && error.code === 10) {
      self.logger.info('SoloistConnect: build expired, re-downloading');
      self.commandRouter.pushToastMessage(
        'info',
        'Spotify Soloist',
        'Installed Soloist build has expired. Downloading a fresh build from Spotify...'
      );
      download();
    } else {
      // Any other failure mode: let the daemon itself surface it via systemd
      defer.resolve();
    }
  });

  return defer.promise;
};

// Config values are validated at the boundary by validateSettings() before they
// reach the store, and v-conf enforces the types declared in config.json. This
// writer therefore trusts the config and does no revalidation.
SoloistConnect.prototype.writeEnvFile = function () {
  const esc = (v) => String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const lines = [
    `API_KEY="${esc(this.config.get('api_key'))}"`,
    `DEVICE_NAME="${esc(this.config.get('device_name'))}"`,
    `INITIAL_VOLUME="${this.config.get('initial_volume')}"`,
    `CACHE_SIZE="${this.config.get('cache_size_mb')}"`,
    `TLENGTH_MS="${this.config.get('buffer_ms')}"`,
    // Read by uninstall.sh, which runs after the plugin config has been
    // rendered unreadable and cannot consult it.
    `RETAIN_API_KEY="${this.config.get('retain_api_key') === true ? 'true' : 'false'}"`,
  ];
  if (this.config.get('verbose_logging') === true) {
    lines.push('VERBOSE="true"');
  }

  fs.mkdirSync('/data/soloist', { recursive: true });
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 });
};

// ---------------------------------------------------------------------------
// WebSocket client (Soloist local API)
// ---------------------------------------------------------------------------

SoloistConnect.prototype.connectWebSocket = function () {
  const self = this;
  this.disconnectWebSocket();

  const url = `ws://${WS_HOST}:${WS_PORT}`;
  this.logger.info('SoloistConnect: connecting to ' + url);

  try {
    this.ws = new WebSocket(url);
  } catch (e) {
    this.scheduleReconnect();
    return;
  }

  this.ws.on('open', () => {
    self.logger.info('SoloistConnect: WebSocket connected');
    self.fetchAudioSpec();
    self.sendCommand({ command: 'get_state' });
  });

  this.ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    self.handleEvent(msg);
  });

  this.ws.on('close', () => self.scheduleReconnect());
  this.ws.on('error', () => {
    /* close will follow */
  });
};

SoloistConnect.prototype.disconnectWebSocket = function () {
  if (this.wsReconnectTimer) {
    clearTimeout(this.wsReconnectTimer);
    this.wsReconnectTimer = null;
  }
  if (this.ws) {
    try {
      this.ws.removeAllListeners();
      // ws closes cleanly, but the socket can still fail while it is being torn
      // down (e.g. the daemon is stopped at the same moment). An 'error' with no
      // listener on an EventEmitter throws and would take Volumio down, so log
      // it rather than swallow it.
      this.ws.on('error', (e) => {
        this.logger.warn('SoloistConnect: error while closing WebSocket: ' + e.message);
      });
      this.ws.close();
    } catch (e) {
      this.logger.warn('SoloistConnect: WebSocket close failed: ' + e.message);
    }
    this.ws = null;
  }
};

SoloistConnect.prototype.scheduleReconnect = function () {
  const self = this;
  if (this.wsReconnectTimer) return;
  this.wsReconnectTimer = setTimeout(() => {
    self.wsReconnectTimer = null;
    self.connectWebSocket();
  }, 5000);
};

SoloistConnect.prototype.sendCommand = function (payload) {
  if (this.ws && this.ws.readyState === WebSocket.OPEN) {
    this.ws.send(JSON.stringify(Object.assign({ type: 'command' }, payload)));
  }
};

// Soloist's WebSocket API does not expose codec/samplerate/bitdepth.
// Audio leaves through pcm.volumio, so report the ALSA hw_params of any
// open playback stream (the shared AAMPP chain).
SoloistConnect.prototype.fetchAudioSpec = function () {
  const self = this;
  exec(
    'sh -c "cat /proc/asound/card*/pcm*p/sub*/hw_params 2>/dev/null"',
    { timeout: 5000 },
    (error, stdout) => {
      if (error || !stdout) return;
      const rateM = stdout.match(/rate:\s*(\d+)/);
      const fmtM = stdout.match(/format:\s*(\S+)/);
      const chM = stdout.match(/channels:\s*(\d+)/);
      if (!rateM && !fmtM) return;

      const rate = rateM ? parseInt(rateM[1], 10) : 0;
      const fmt = fmtM ? fmtM[1] : '';
      const channels = chM ? parseInt(chM[1], 10) : 2;

      let bitdepth = '';
      if (/S16/.test(fmt)) bitdepth = '16 bit';
      else if (/S24/.test(fmt)) bitdepth = '24 bit';
      else if (/S32|FLOAT/.test(fmt)) bitdepth = '32 bit';

      self.audioSpec = {
        samplerate: rate ? (rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1) + ' kHz' : '',
        bitdepth: bitdepth,
        channels: channels || 2,
      };
    }
  );
};

// ---------------------------------------------------------------------------
// Stream quality
// ---------------------------------------------------------------------------

// Soloist reports neither codec nor bitrate, and this is not an oversight in
// our reading of it. The full WebSocket schema is documented, and playback_state
// carries only status, item, context, position, volume, is_active, options and
// available_actions; the entity envelope carries identity, visual_identity,
// parent, creators and playback.duration_ms. There is no quality field anywhere,
// and others have asked Spotify for one on the developer forum.
//
// The bit depth ALSA reports is no guide either. Soloist decodes every quality
// into FLOAT_LE, and the /proc/asound endpoint shows S24_LE because
// pcm.softvolume converts, so that field read "24 bit" for lossy and lossless
// alike.
//
// So the cache is the only signal, and it has to be read carefully.
//
// Identify the file by open descriptor, not by mtime. Soloist holds the playing
// track's file open under /proc/<pid>/fd and it follows every skip within a
// second. Choosing by mtime instead paired a file with the wrong track: the same
// 6289411 bytes was measured against 185 s and then 232 s, reporting "Very High"
// and then "High" for one file, because the file came from the cache and the
// duration from a later track_changed event.
//
// Audio payloads live under cache/cache/; the LevelDB metadata store is under
// data/cache/ and must not match.
//
// A track's file is already complete when playback starts: sampled every two
// seconds over ten, the size did not move. Under rapid skipping no file is
// unambiguously open -- nine different files in twenty-seven seconds -- so no
// measurement is taken and the previous label stands.
SoloistConnect.prototype.updateQuality = function (uri, durationMs) {
  if (!durationMs || durationMs <= 0) return;

  const open = this.openCacheFile();
  if (!open) return;

  // A unique open fd is the playing track. Defer only when the fd just
  // changed: that is a skip handover, and the duration may still be the
  // previous track's. The first-URI skip hid the tier until a later event,
  // which a mid-track resume never sends.
  if (this.qualityPath && this.qualityPath !== open.path) {
    this.qualityPath = open.path;
    this.qualityUri = uri;
    return;
  }
  this.qualityUri = uri;
  this.qualityPath = open.path;

  const kbps = Math.round((open.size * 8) / (durationMs / 1000) / 1000);
  let sample = '';
  for (const tier of QUALITY_TIERS) {
    if (kbps < tier.max) {
      sample = tier.label;
      break;
    }
  }

  this.logger.info(
    'SoloistConnect: open ' + open.path + ' ' + open.size + ' bytes over ' +
    Math.round(durationMs / 1000) + 's = ' + kbps + ' kbps -> ' + sample
  );

  this.quality = sample;
};

// The cache file Soloist currently has open for reading, which is the track
// playing now. Null when none is open, when more than one is (a handover
// between tracks), or when the daemon is not readable.
SoloistConnect.prototype.openCacheFile = function () {
  const pid = this.daemonPid();
  if (!pid) return null;

  let entries;
  try {
    entries = fs.readdirSync('/proc/' + pid + '/fd');
  } catch (e) {
    return null; // daemon gone, or not ours to read
  }

  const found = [];
  for (const fd of entries) {
    let target;
    try {
      target = fs.readlinkSync('/proc/' + pid + '/fd/' + fd);
    } catch (e) {
      continue; // fd closed between readdir and readlink
    }
    // Audio payload only. The LevelDB metadata store lives under data/cache/
    // and would otherwise match on the word "cache".
    if (target.indexOf(CACHE_DIR + '/cache/') !== 0) continue;
    if (!target.endsWith('.file')) continue;
    if (found.indexOf(target) === -1) found.push(target);
  }

  // Two open files means a handover is in progress and neither is
  // unambiguously the playing track.
  if (found.length !== 1) return null;

  let size;
  try {
    size = fs.statSync(found[0]).size;
  } catch (e) {
    return null;
  }
  if (!size) return null;

  return { path: found[0], size: size };
};

SoloistConnect.prototype.daemonPid = function () {
  try {
    const out = execSync(
      '/bin/systemctl show -p MainPID --value ' + SERVICE_UNIT,
      { encoding: 'utf8', timeout: 2000 }
    ).trim();
    const pid = parseInt(out, 10);
    return pid > 0 ? pid : 0;
  } catch (e) {
    return 0;
  }
};

// ---------------------------------------------------------------------------
// Soloist events -> Volumio state
// ---------------------------------------------------------------------------

// Only trust is_active when the event actually carries it. Many Soloist events
// (e.g. auth_state on a token refresh) omit the field; treating a missing field
// as `false` made the plugin think the Connect session ended, which let
// Volumio's routine stop() echoes reach Soloist as real pause commands and
// caused an endless play/pause loop.
SoloistConnect.prototype.updateActive = function (msg) {
  if (typeof msg.is_active !== 'boolean') return;
  if (!this.active && msg.is_active) this.activatedAt = Date.now();
  this.active = msg.is_active;
};

// ---------------------------------------------------------------------------
// Device ownership
// ---------------------------------------------------------------------------
//
// Same contract as bluetooth's btAudioOutput: the PCM is the lock, and
// yield does not return until we no longer hold it. Bluetooth SIGKILLs
// bluealsa-aplay. We cannot kill Soloist, so apulse closes the handle and
// we wait here until /proc/asound shows it gone. Takeover is the reverse:
// volumioStop, wait until someone else has dropped the device, then claim.
//
// `active` is Spotify Connect device status. It is not cleared on yield:
// clearing it made the next is_active=true look like a new selection and
// stole the session back from MPD.

SoloistConnect.prototype.alsaOwnerPids = function () {
  let out = '';
  try {
    out = execSync('sh -c "cat /proc/asound/card*/pcm*p/sub*/status 2>/dev/null"', {
      encoding: 'utf8',
      timeout: 500,
    });
  } catch (e) {
    return [];
  }
  const pids = [];
  const re = /owner_pid\s*:\s*(\d+)/g;
  let m;
  while ((m = re.exec(out))) pids.push(parseInt(m[1], 10));
  return pids;
};

SoloistConnect.prototype.daemonPids = function () {
  const pids = [];
  try {
    const main = parseInt(
      execSync('systemctl show -p MainPID --value ' + SERVICE_UNIT, {
        encoding: 'utf8',
        timeout: 500,
      }).trim(),
      10
    );
    if (main > 0) pids.push(main);
  } catch (e) {
    /* unit not running */
  }
  const owners = this.alsaOwnerPids();
  for (let i = 0; i < owners.length; i++) {
    if (pids.indexOf(owners[i]) >= 0) continue;
    try {
      const comm = fs.readFileSync('/proc/' + owners[i] + '/comm', 'utf8').trim();
      if (comm === 'soloist' || comm === 'launch-soloist.sh') pids.push(owners[i]);
    } catch (e) {
      /* process gone */
    }
  }
  return pids;
};

SoloistConnect.prototype.alsaHeldByUs = function () {
  const us = this.daemonPids();
  if (!us.length) return false;
  const owners = this.alsaOwnerPids();
  for (let i = 0; i < owners.length; i++) {
    if (us.indexOf(owners[i]) >= 0) return true;
  }
  return false;
};

SoloistConnect.prototype.alsaHeldByOther = function () {
  const us = this.daemonPids();
  const owners = this.alsaOwnerPids();
  for (let i = 0; i < owners.length; i++) {
    if (us.indexOf(owners[i]) < 0) return true;
  }
  return false;
};

SoloistConnect.prototype.waitUntil = function (pred, timeoutMs) {
  const self = this;
  const defer = libQ.defer();
  const deadline = Date.now() + (timeoutMs || 2000);
  const tick = function () {
    if (pred.call(self)) {
      defer.resolve();
      return;
    }
    if (Date.now() >= deadline) {
      defer.resolve();
      return;
    }
    setTimeout(tick, 20);
  };
  tick();
  return defer.promise;
};

// What Volumio currently considers the active service, as ytcr's
// isCurrentService() does. Asking Volumio rather than trusting our own flag is
// the difference between taking the device once and taking it repeatedly.
SoloistConnect.prototype.isCurrentService = function () {
  try {
    const state = this.commandRouter.volumioGetState();
    return !!(state && state.service === this.servicename);
  } catch (e) {
    return false;
  }
};

SoloistConnect.prototype.otherServicePlaying = function () {
  try {
    const state = this.commandRouter.volumioGetState();
    return !!(
      state &&
      state.service &&
      state.service !== this.servicename &&
      (state.status === 'play' || state.status === 'pause')
    );
  } catch (e) {
    return false;
  }
};

SoloistConnect.prototype.takeOverPlayback = function () {
  if (this.isCurrentService() && this.alsaHeldByOther()) {
    const self = this;
    this.logger.info('SoloistConnect: taking over playback');
    try {
      this.commandRouter.executeOnPlugin('music_service', 'mpd', 'stop');
    } catch (e) {
      this.logger.error('SoloistConnect: failed to stop MPD: ' + e);
    }
    this.waitUntil(function () { return !this.alsaHeldByOther(); }, 2000)
      .then(function () { self.setVolatile(); });
    return;
  }

  if (!this.otherServicePlaying() && !this.alsaHeldByOther()) {
    this.setVolatile();
    return;
  }

  const self = this;
  const sm = this.context.coreCommand.stateMachine;

  this.logger.info('SoloistConnect: taking over playback');

  const afterFree = function () {
    if (sm.isVolatile) {
      sm.unSetVolatile();
    }
    if (typeof sm.setConsumeUpdateService === 'function') {
      sm.setConsumeUpdateService(undefined);
    }
    self.setVolatile();
  };

  const afterStop = function () {
    self.waitUntil(function () { return !self.alsaHeldByOther(); }, 2000)
      .then(afterFree);
  };

  try {
    const p = this.context.coreCommand.volumioStop();
    if (p && typeof p.then === 'function') {
      p.then(afterStop).fail(function (e) {
        self.logger.error('SoloistConnect: playback takeover failed: ' + e);
        afterStop();
      });
    } else {
      afterStop();
    }
  } catch (e) {
    this.logger.error('SoloistConnect: playback takeover failed: ' + e);
    afterStop();
  }
};

SoloistConnect.prototype.handleEvent = function (msg) {
  switch (msg.type) {
    case 'auth_state':
      this.updateActive(msg);
      if (msg.logged_in) this.sendCommand({ command: 'get_state' });
      if (typeof msg.is_active === 'boolean' && !msg.is_active) this.unsetVolatile();
      break;

    case 'playback_state':
      this.updateActive(msg);
      this.setStatus(msg.status);
      this.applyPosition(msg.position);
      if (msg.item) this.applyItem(msg.item);
      if (typeof msg.volume === 'number') this.applySoloistVolume(msg.volume);
      this.schedulePushState();
      break;

    case 'track_changed':
      if (msg.item) this.applyItem(msg.item);
      this.pushStateNow();
      break;

    case 'playback_changed':
      this.setStatus(msg.status);
      this.pushStateNow();
      break;

    case 'device_changed':
      this.updateActive(msg);
      if (!this.active) this.unsetVolatile();
      break;

    case 'position_sync':
      // Update the anchor only. A full push here used to sit on the
      // coalesced timer and delay skip UI. The seek timer publishes
      // the moving bar; a large jump (user seek) pushes immediately.
      {
        const before = this.currentSeekMs();
        this.applyPosition(msg.position);
        this.state.seek = this.currentSeekMs();
        if (this.volatileSet && Math.abs(this.state.seek - before) > 2000) {
          this.publishState(this.stateSnapshot());
        }
      }
      break;

    default:
      break;
  }
};

SoloistConnect.prototype.setStatus = function (soloistStatus) {
  const mapped = this.mapStatus(soloistStatus);
  if (mapped === 'play' && this.state.status !== 'play') {
    if (this.pendingYieldAt && Date.now() - this.pendingYieldAt < 1500) {
      this.state.status = 'pause';
      this.syncSeekTimer();
      return;
    }
    this.pendingYieldAt = 0;
    this.lastPlayTransitionAt = Date.now();
    // The ALSA stream only exists once playback starts. At WebSocket connect
    // /proc/asound reports "closed", so the sample rate has to be read here or
    // it is never read at all.
    this.fetchAudioSpec();
    this.takeOverPlayback();
  }
  this.state.status = mapped;
  this.syncSeekTimer();
};

SoloistConnect.prototype.mapStatus = function (s) {
  if (s === 'playing') return 'play';
  // Buffering happens briefly at every track start/seek; pushing it as 'pause'
  // makes Volumio's state machine flap pause/play and echo commands back.
  if (s === 'buffering') return this.state.status === 'play' ? 'play' : 'pause';
  if (s === 'paused') return 'pause';
  return 'stop'; // idle
};

SoloistConnect.prototype.applyItem = function (item) {
  const dec = (item && item.decorations) || {};
  const identity = dec.identity || {};
  const parent = dec.parent && dec.parent.entity;
  const creators = dec.creators || [];
  const playback = dec.playback || {};
  const covers = (dec.visual_identity && dec.visual_identity.cover) || [];

  this.state.uri = item.uri || '';
  this.state.title = identity.name || '';
  this.state.album =
    (parent && parent.decorations && parent.decorations.identity
      ? parent.decorations.identity.name
      : '') || '';
  this.state.artist = creators
    .map((c) =>
      c.entity && c.entity.decorations && c.entity.decorations.identity
        ? c.entity.decorations.identity.name
        : ''
    )
    .filter(Boolean)
    .join(', ');
  this.state.duration = Math.round((playback.duration_ms || 0) / 1000);
  this.updateQuality(item.uri || '', playback.duration_ms);

  let art = '';
  const preferred = ['large', 'xlarge', 'default', 'small'];
  for (const size of preferred) {
    const hit = covers.find((c) => c.size === size);
    if (hit) {
      art = hit.url;
      break;
    }
  }
  if (!art && covers.length) art = covers[0].url;
  this.state.albumart = art || '/albumart';
};

SoloistConnect.prototype.applyPosition = function (pos) {
  if (pos == null) return;
  if (typeof pos === 'number' && Number.isFinite(pos)) {
    this.positionAnchor = {
      position_ms: pos,
      timestamp_ms: Date.now(),
      speed: this.state.status === 'play' ? 1 : 0,
    };
    return;
  }
  if (typeof pos !== 'object') return;
  const positionMs = Number(
    pos.position_ms != null ? pos.position_ms : pos.position
  );
  if (!Number.isFinite(positionMs)) return;
  const timestampMs = Number(pos.timestamp_ms);
  this.positionAnchor = {
    position_ms: positionMs,
    timestamp_ms: Number.isFinite(timestampMs) ? timestampMs : Date.now(),
    speed: this.state.status === 'play' ? 1 : 0,
  };
};

SoloistConnect.prototype.currentSeekMs = function () {
  const a = this.positionAnchor;
  const speed = this.state.status === 'play' ? 1 : 0;
  return Math.max(
    0,
    Math.round((a.position_ms || 0) + (Date.now() - a.timestamp_ms) * speed)
  );
};

// Volatile getState() returns a snapshot. The UI does not advance seek
// on its own. Tick locally and push once a second while playing.
SoloistConnect.prototype.syncSeekTimer = function () {
  if (this.state.status === 'play' && this.active) {
    if (this.seekTimer) return;
    this.seekTimer = setInterval(() => {
      if (this.state.status !== 'play' || !this.active) {
        this.stopSeekTimer();
        return;
      }
      this.state.seek = this.currentSeekMs();
      if (this.volatileSet) {
        this.publishState(this.stateSnapshot());
      }
    }, 1000);
    return;
  }
  this.stopSeekTimer();
};

SoloistConnect.prototype.stopSeekTimer = function () {
  if (!this.seekTimer) return;
  clearInterval(this.seekTimer);
  this.seekTimer = null;
};

SoloistConnect.prototype.emptyState = function () {
  return {
    status: 'stop',
    service: this.servicename,
    title: '',
    artist: '',
    album: '',
    albumart: '/albumart',
    uri: '',
    trackType: 'spotify',
    seek: 0,
    duration: 0,
    samplerate: '',
    bitdepth: '',
    channels: 2,
    disableUiControls: false,
  };
};

// Soloist fires playback_state + track_changed + playback_changed together.
// Coalesce those to one push on the next turn. Do not add a delay — a
// pending timer was swallowing skip/track updates until the next tick
// from Soloist (often seconds).
SoloistConnect.prototype.schedulePushState = function () {
  if (this.pushStateTimer) {
    this.pushStateDirty = true;
    return;
  }
  this.pushStateTimer = setImmediate(() => {
    this.pushStateTimer = null;
    this.pushState();
    if (this.pushStateDirty) {
      this.pushStateDirty = false;
      this.schedulePushState();
    }
  });
};

SoloistConnect.prototype.pushStateNow = function () {
  if (this.pushStateTimer) {
    clearImmediate(this.pushStateTimer);
    this.pushStateTimer = null;
  }
  this.pushStateDirty = false;
  this.pushState();
};

// Publishing state must never re-enter itself.
//
// servicePushState drives Volumio's state machine synchronously: syncState,
// pushState, volumioPushState, then every interface plugin. If anything in that
// chain leads back here, the second publication nests inside the first and the
// stack grows until JSON.stringify in the Socket.IO encoder throws
// RangeError: Maximum call stack size exceeded. That is what a fatal crash on
// takeover looked like, with the encoder as the victim rather than the cause.
//
// Two rules, both cheap:
//   - a re-entry guard, so a nested call is dropped rather than recursing;
//   - publish a snapshot, never this.state, so Volumio cannot observe the live
//     object mutating underneath it during nested publication. The state
//     machine keeps volatileState by reference, so handing it the live object
//     aliases our mutable state into core.
SoloistConnect.prototype.stateSnapshot = function () {
  return Object.assign({}, this.state);
};

SoloistConnect.prototype.publishState = function (state) {
  if (this.publishing) {
    this.logger.warn(
      'SoloistConnect: state publication re-entered; dropping nested push'
    );
    return;
  }
  this.publishing = true;
  try {
    this.commandRouter.servicePushState(state, this.servicename);
  } finally {
    this.publishing = false;
  }
};

SoloistConnect.prototype.pushState = function () {
  if (!this.active) return;
  // Only publish while we are the volatile service. setVolatile is asserted
  // once, on the takeover edge in updateActive, not here: calling it from
  // pushState meant every event from a still-connected phone re-claimed the
  // session, so our metadata overwrote whatever the user had switched to.
  if (!this.volatileSet) return;
  this.state.service = this.servicename;
  this.state.seek = this.currentSeekMs();
  // The quality tier is measured from the cache and does not depend on ALSA, so
  // it must not be gated behind audioSpec. fetchAudioSpec runs when the
  // WebSocket connects, at which point nothing is playing and /proc/asound
  // reads "closed", so audioSpec stayed unset and a correctly measured tier was
  // never shown.
  this.state.bitdepth = this.quality;
  if (this.audioSpec) {
    this.state.samplerate = this.audioSpec.samplerate;
    this.state.channels = this.audioSpec.channels;
  }
  this.publishState(this.stateSnapshot());
};

SoloistConnect.prototype.setVolatile = function () {
  if (this.volatileSet) return;
  this.volatileSet = true;
  this.context.coreCommand.stateMachine.setVolatile({
    service: this.servicename,
    callback: this.unsetVolatile.bind(this),
  });

  // Volumio emits a stop() echo shortly after volatile mode begins. Swallow
  // that window and nothing more. The stock Spotify plugin uses the same two
  // seconds, cleared unconditionally: a latch tied to session state made every
  // later stop unreachable.
  this.ignoreStopEvent = true;
  if (this.ignoreStopTimer) clearTimeout(this.ignoreStopTimer);
  this.ignoreStopTimer = setTimeout(() => {
    this.ignoreStopTimer = null;
    this.ignoreStopEvent = false;
  }, 2000);
};

SoloistConnect.prototype.unsetVolatile = function () {
  if (!this.volatileSet) return;
  this.volatileSet = false;
  if (this.pushStateTimer) {
    clearImmediate(this.pushStateTimer);
    this.pushStateTimer = null;
  }
  this.pushStateDirty = false;
  this.stopSeekTimer();
  this.state = this.emptyState();
  this.pendingYieldAt = Date.now();
  this.sendCommand({ command: 'pause' });

  const deadline = Date.now() + 2000;
  while (this.alsaHeldByUs() && Date.now() < deadline) {
    try {
      execSync('sleep 0.02', { timeout: 200 });
    } catch (e) {
      break;
    }
  }

  try {
    this.context.coreCommand.stateMachine.unSetVolatile();
  } catch (e) {
    /* already cleared by core, which is the common case */
  }
};

// ---------------------------------------------------------------------------
// Volumio playback controls -> Soloist commands
// ---------------------------------------------------------------------------

// Volumio emits a stop() echo shortly after volatile mode begins; setVolatile
// opens a two-second window for it. Outside that window a stop is real and is
// forwarded, which is what lets the user select another source.
//
// This used to read `if (this.ignoreStopEvent || this.active)`, so no stop ever
// reached Soloist while a Connect session existed and the device could not be
// released. ytcr's stop() has no suppression at all; the stock Spotify plugin
// suppresses only inside its own two-second window.
SoloistConnect.prototype.stop = function () {
  if (this.ignoreStopEvent) {
    this.logger.info('SoloistConnect: ignoring stop echo from volatile setup');
    return libQ.resolve();
  }
  this.logger.info('SoloistConnect: yielding playback');
  this.pendingYieldAt = Date.now();
  this.sendCommand({ command: 'pause' });
  const self = this;
  return this.waitUntil(function () { return !this.alsaHeldByUs(); }, 2000)
    .then(function () {
      if (self.alsaHeldByUs()) {
        self.logger.error('SoloistConnect: ALSA still held after yield');
      }
    });
};

SoloistConnect.prototype.pause = function () {
  this.logger.info('SoloistConnect: forwarding pause');
  this.sendCommand({ command: 'pause' });
  return libQ.resolve();
};

SoloistConnect.prototype.play = function () {
  this.sendCommand({ command: 'play' });
  return libQ.resolve();
};

SoloistConnect.prototype.resume = function () {
  this.sendCommand({ command: 'play' });
  return libQ.resolve();
};

SoloistConnect.prototype.next = function () {
  this.sendCommand({ command: 'skip_next' });
  return libQ.resolve();
};

SoloistConnect.prototype.previous = function () {
  this.sendCommand({ command: 'skip_prev' });
  return libQ.resolve();
};

SoloistConnect.prototype.seek = function (positionMs) {
  this.sendCommand({ command: 'seek', position_ms: Math.round(positionMs) });
  return libQ.resolve();
};

SoloistConnect.prototype.random = function (value) {
  this.sendCommand({ command: 'set_shuffle', enabled: !!value });
  return libQ.resolve();
};

SoloistConnect.prototype.repeat = function (value, repeatSingle) {
  // Coordinate both repeat commands per the Soloist WebSocket API reference
  if (repeatSingle) {
    this.sendCommand({ command: 'set_repeat_context', enabled: false });
    this.sendCommand({ command: 'set_repeat_track', enabled: true });
  } else if (value) {
    this.sendCommand({ command: 'set_repeat_track', enabled: false });
    this.sendCommand({ command: 'set_repeat_context', enabled: true });
  } else {
    this.sendCommand({ command: 'set_repeat_track', enabled: false });
    this.sendCommand({ command: 'set_repeat_context', enabled: false });
  }
  return libQ.resolve();
};

// A snapshot, not the live object. Volumio's state machine stores what it is
// given by reference, so returning this.state would let core observe our
// mutations mid-publication.
SoloistConnect.prototype.getState = function () {
  this.state.seek = this.currentSeekMs();
  return this.stateSnapshot();
};

SoloistConnect.prototype.applySoloistVolume = function (vol) {
  this.state.volume = vol;
  this.lastSentVolume = vol;
  this.volumeFromSoloist = true;
  setImmediate(() => {
    this.volumeFromSoloist = false;
  });
};

// Volumio mixer already applies pcm.volumio. Mirror the knob to Connect
// so the Spotify app slider matches. Collapse bursts — do not queue a
// set_volume per tick in front of skip/pause (Soloist handles commands
// serially; that queue was seconds of lag).
SoloistConnect.prototype.onVolumioVolume = function (data) {
  if (!this.active || this.volumeFromSoloist) return;
  const vol = data && typeof data.vol === 'number' ? data.vol : data;
  if (typeof vol !== 'number' || isNaN(vol)) return;
  const rounded = Math.round(vol);
  if (Math.abs(rounded - this.lastSentVolume) < 2) return;
  if (this.volumeTimer) clearTimeout(this.volumeTimer);
  this.volumeTimer = setTimeout(() => {
    this.volumeTimer = null;
    this.lastSentVolume = rounded;
    this.sendCommand({ command: 'set_volume', volume: rounded });
  }, 80);
};

SoloistConnect.prototype.volume = function (data) {
  this.onVolumioVolume(data);
  return libQ.resolve();
};

// ---------------------------------------------------------------------------
// UI configuration
// ---------------------------------------------------------------------------

SoloistConnect.prototype.getUIConfig = function () {
  const defer = libQ.defer();
  const self = this;
  const langCode = this.commandRouter.sharedVars.get('language_code');

  this.commandRouter
    .i18nJson(
      path.join(__dirname, 'i18n', `strings_${langCode}.json`),
      path.join(__dirname, 'i18n', 'strings_en.json'),
      path.join(__dirname, 'UIConfig.json')
    )
    .then((uiconf) => {
      // Look up by id rather than by position. Inserting a field mid-list
      // silently shifted every index below it.
      const set = (id, value) => {
        const el = uiconf.sections[0].content.find((c) => c.id === id);
        if (el) el.value = value;
      };

      set('api_key', self.config.get('api_key') || '');
      set('retain_api_key', self.config.get('retain_api_key') === true);
      set('device_name', self.config.get('device_name') || 'Volumio');
      set('initial_volume', self.config.get('initial_volume'));
      set('cache_size_mb', self.config.get('cache_size_mb'));
      set('buffer_ms', self.config.get('buffer_ms'));
      set('verbose_logging', self.config.get('verbose_logging') === true);
      defer.resolve(uiconf);
    })
    .fail((e) => defer.reject(new Error('Failed loading UIConfig: ' + e)));

  return defer.promise;
};

// Validate before writing. v-conf enforces the type declared in config.json and
// throws on a non-numeric value, so a cleared number field must be rejected here
// with a message rather than reaching the config store. Returning early leaves
// the stored settings untouched and the daemon running on the last good values.
SoloistConnect.prototype.validateSettings = function (data) {
  const initialVolume = parseInt(data.initial_volume, 10);
  if (isNaN(initialVolume) || initialVolume < 0 || initialVolume > 100) {
    return { ok: false, message: 'Initial volume must be a number between 0 and 100.' };
  }

  const cacheSize = parseInt(data.cache_size_mb, 10);
  if (isNaN(cacheSize) || (cacheSize !== 0 && cacheSize < 100)) {
    return { ok: false, message: 'Cache size must be 0 (no limit) or at least 100 MB.' };
  }

  // Bounded because minreq, and therefore the ALSA period, is derived as
  // tlength/4. Below 100ms the period drops under 25ms and xruns become likely
  // on a loaded device; 2000ms restores upstream apulse behaviour.
  const bufferMs = parseInt(data.buffer_ms, 10);
  if (isNaN(bufferMs) || bufferMs < 100 || bufferMs > 2000) {
    return { ok: false, message: 'Output buffer must be between 100 and 2000 ms.' };
  }

  return {
    ok: true,
    values: {
      api_key: (data.api_key || '').trim(),
      device_name: (data.device_name || '').trim() || 'Volumio',
      initial_volume: initialVolume,
      cache_size_mb: cacheSize,
      buffer_ms: bufferMs,
      retain_api_key: !!data.retain_api_key,
      verbose_logging: !!data.verbose_logging,
    },
  };
};

SoloistConnect.prototype.saveSoloistSettings = function (data) {
  const self = this;

  const result = this.validateSettings(data);
  if (!result.ok) {
    this.logger.error('SoloistConnect: rejected settings: ' + result.message);
    this.commandRouter.pushToastMessage('error', 'Spotify Soloist', result.message);
    return libQ.resolve();
  }

  this.config.set('api_key', result.values.api_key);
  this.config.set('device_name', result.values.device_name);
  this.config.set('initial_volume', result.values.initial_volume);
  this.config.set('cache_size_mb', result.values.cache_size_mb);
  this.config.set('buffer_ms', result.values.buffer_ms);
  this.config.set('retain_api_key', result.values.retain_api_key);
  this.config.set('verbose_logging', result.values.verbose_logging);

  this.commandRouter.pushToastMessage('success', 'Spotify Soloist', 'Settings saved. Restarting Soloist...');
  return this.startDaemon()
    .then(() => self.connectWebSocket())
    .fail((e) => {
      self.logger.error('SoloistConnect: save/restart failed: ' + e);
      return libQ.resolve(); // keep UI responsive; error already toasted
    });
};

SoloistConnect.prototype.updateSoloistBinary = function () {
  const self = this;
  const defer = libQ.defer();
  exec(
    this.downloadScript(),
    { timeout: 300000 },
    (error) => {
      if (error) {
        self.commandRouter.pushToastMessage('error', 'Spotify Soloist', 'Update failed: ' + error);
        defer.reject(error);
      } else {
        self.commandRouter.pushToastMessage('success', 'Spotify Soloist', 'Soloist binary updated.');
        self.startDaemon()
          .then(() => {
            self.connectWebSocket();
            defer.resolve();
          })
          .fail((e) => defer.reject(e));
      }
    }
  );
  return defer.promise;
};
