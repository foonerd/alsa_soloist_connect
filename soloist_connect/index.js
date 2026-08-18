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
  this.ignoreStopEvent = false;
  this.state = this.emptyState();
  this.positionAnchor = { position_ms: 0, timestamp_ms: Date.now(), speed: 0 };
  this.pushStateTimer = null;
  this.pushStateDirty = false;
  this.volumeTimer = null;
  this.lastSentVolume = -1;
  this.volumeFromSoloist = false;
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
  return libQ.resolve();
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
  ];
  if (this.config.get('verbose_logging') === true) {
    lines.push('VERBOSE="true"');
  }

  fs.mkdirSync('/data/soloist', { recursive: true });
  fs.writeFileSync('/data/soloist/soloist.env', lines.join('\n') + '\n', { mode: 0o600 });
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
// Soloist events -> Volumio state
// ---------------------------------------------------------------------------

// Only trust is_active when the event actually carries it. Many Soloist events
// (e.g. auth_state on a token refresh) omit the field; treating a missing field
// as `false` made the plugin think the Connect session ended, which let
// Volumio's routine stop() echoes reach Soloist as real pause commands and
// caused an endless play/pause loop.
SoloistConnect.prototype.updateActive = function (msg) {
  if (typeof msg.is_active !== 'boolean') return;
  if (!this.active && msg.is_active) {
    this.activatedAt = Date.now();
    this.takeOverPlayback();
  }
  this.active = msg.is_active;
};

// AirPlay (prepareAirplayPlayback) stops the current service and clears
// consume-update before taking the DAC. Official Spotify left the same
// idea as a TODO on will_play. setVolatile() alone does not stop MPD.
// Pi I2S is exclusive; x86 HDA/USB often has dmix — same plugin, different
// hardware rules.
SoloistConnect.prototype.takeOverPlayback = function () {
  this.ignoreStopEvent = true;
  try {
    const sm = this.context.coreCommand.stateMachine;
    const state = typeof sm.getState === 'function' ? sm.getState() : null;
    if (state && state.service && state.service !== this.servicename) {
      if (sm.isVolatile) {
        this.logger.info('SoloistConnect: unsetting volatile service ' + state.service);
        sm.unSetVolatile();
      } else {
        this.logger.info('SoloistConnect: stopping ' + state.service + ' to free pcm.volumio');
        this.context.coreCommand.volumioStop();
      }
    }
    if (typeof sm.setConsumeUpdateService === 'function') {
      sm.setConsumeUpdateService(undefined);
    }
  } catch (e) {
    this.logger.error('SoloistConnect: playback takeover failed: ' + e);
  }
  this.releaseAlsaDevice();
};

SoloistConnect.prototype.releaseAlsaDevice = function () {
  try {
    const mpd = this.commandRouter.pluginManager.getPlugin('music_service', 'mpd');
    if (mpd && typeof mpd.stop === 'function') {
      this.logger.info('SoloistConnect: stopping MPD to free pcm.volumio');
      mpd.stop();
    }
  } catch (e) {
    this.logger.error('SoloistConnect: could not stop MPD: ' + e);
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
      if (msg.position) this.positionAnchor = msg.position;
      this.setStatus(msg.status);
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
      // Seek only. A full servicePushState here used to sit on the
      // coalesced timer and delay track_changed / skip UI until the next
      // Soloist tick (seconds).
      if (msg.position) this.positionAnchor = msg.position;
      this.state.seek = this.currentSeekMs();
      break;

    default:
      break;
  }
};

SoloistConnect.prototype.setStatus = function (soloistStatus) {
  const mapped = this.mapStatus(soloistStatus);
  if (mapped === 'play' && this.state.status !== 'play') {
    this.lastPlayTransitionAt = Date.now();
  }
  this.state.status = mapped;
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

SoloistConnect.prototype.currentSeekMs = function () {
  const a = this.positionAnchor;
  return Math.max(0, Math.round(a.position_ms + (Date.now() - a.timestamp_ms) * (a.speed || 0)));
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

SoloistConnect.prototype.pushState = function () {
  if (!this.active) return;
  this.setVolatile();
  this.state.service = this.servicename;
  this.state.seek = this.currentSeekMs();
  if (this.audioSpec) {
    this.state.samplerate = this.audioSpec.samplerate;
    this.state.bitdepth = this.audioSpec.bitdepth;
    this.state.channels = this.audioSpec.channels;
  }
  this.commandRouter.servicePushState(this.state, this.servicename);
};

SoloistConnect.prototype.setVolatile = function () {
  if (this.volatileSet) return;
  this.volatileSet = true;
  this.takeOverPlayback();
  this.context.coreCommand.stateMachine.setVolatile({
    service: this.servicename,
    callback: this.unsetVolatile.bind(this),
  });
};

SoloistConnect.prototype.unsetVolatile = function () {
  if (!this.volatileSet) return;
  this.volatileSet = false;
  if (this.pushStateTimer) {
    clearImmediate(this.pushStateTimer);
    this.pushStateTimer = null;
  }
  this.pushStateDirty = false;
  this.state = this.emptyState();
  try {
    this.context.coreCommand.stateMachine.unSetVolatile();
    this.context.coreCommand.stateMachine.resetVolumioState().then(() => {
      this.context.coreCommand.volumioStop();
    });
  } catch (e) {
    /* state machine may already be reset */
  }
};

// ---------------------------------------------------------------------------
// Volumio playback controls -> Soloist commands
// ---------------------------------------------------------------------------

// Volumio's state machine calls stop() on volatile services whenever it syncs
// state transitions - roughly 30ms after every "play" we push. While Soloist is
// the active Connect device, those stop() calls are always internal churn (the
// user's pause arrives via pause() or the Spotify app), so ignore them entirely.
SoloistConnect.prototype.stop = function () {
  if (this.ignoreStopEvent || this.active) {
    this.logger.info('SoloistConnect: ignoring stop while Connect session is active');
    return libQ.resolve();
  }
  this.logger.info('SoloistConnect: forwarding stop as pause');
  this.sendCommand({ command: 'pause' });
  return libQ.resolve();
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

SoloistConnect.prototype.getState = function () {
  return this.state;
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
      uiconf.sections[0].content[0].value = self.config.get('api_key') || '';
      uiconf.sections[0].content[1].value = self.config.get('device_name') || 'Volumio';
      uiconf.sections[0].content[2].value = self.config.get('initial_volume');
      uiconf.sections[0].content[3].value = self.config.get('cache_size_mb');
      uiconf.sections[0].content[4].value = self.config.get('verbose_logging') === true;
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

  return {
    ok: true,
    values: {
      api_key: (data.api_key || '').trim(),
      device_name: (data.device_name || '').trim() || 'Volumio',
      initial_volume: initialVolume,
      cache_size_mb: cacheSize,
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
