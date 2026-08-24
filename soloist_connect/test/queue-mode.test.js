// Queue-mode regression check for soloist_connect.
//
// Runs the queue-mode paths against the event payloads captured from hanger on
// 2026-08-24. No daemon, no ALSA, no Volumio: the WebSocket send, the ALSA
// yield and the core state machine are stubbed, so this only asserts the
// decisions this plugin makes, which is exactly the part that is not visible
// from a listening test.
//
//   node test/queue-mode.test.js
//
// Exits non-zero on any failure.

'use strict';

const SoloistConnect = require('../index.js');

const pushed = [];
const logs = [];
const queuePushes = [];
const nextCalls = [];
let queueSaves = 0;
let startPlaybackTimerCalls = 0;

function makeCtx() {
  const sm = {
    isVolatile: false,
    volatileService: undefined,
    volatileCallback: undefined,
    currentPosition: 0,
    currentSongDuration: 0,
    playQueue: { arrayQueue: [], saveQueue() { queueSaves++; } },
    updateTrackBlock() {},
    startPlaybackTimer() { startPlaybackTimerCalls++; },
    next() { nextCalls.push(this.currentPosition); },
    setVolatile(d) { this.isVolatile = true; this.volatileService = d.service; this.volatileCallback = d.callback; },
    unSetVolatile() { if (this.volatileCallback) { this.volatileCallback.call(); this.volatileCallback = undefined; } this.isVolatile = false; this.volatileService = undefined; },
    setConsumeUpdateService() {},
  };
  const coreCommand = {
    stateMachine: sm,
    volumioGetState() { return { service: 'other' }; },
    volumioStop() { return { then: (f) => { f(); return { then: (g) => { g(); return { fail: () => {} }; } }; } }; },
    pluginManager: { getPlugin: () => null },
    servicePushState(state) { pushed.push(JSON.parse(JSON.stringify(state))); },
    volumioPushQueue(q) { queuePushes.push(JSON.parse(JSON.stringify(q))); },
  };
  return {
    coreCommand,
    logger: {
      info: (m) => logs.push('info ' + m),
      error: (m) => logs.push('error ' + m),
      warn: (m) => logs.push('warn ' + m),
    },
    configManager: {},
  };
}

function newPlugin(config) {
  const ctx = makeCtx();
  const p = new SoloistConnect(ctx);
  p.commandRouter = ctx.coreCommand;
  const settings = Object.assign({ queue_playback: true }, config || {});
  p.config = { get: (key) => settings[key] };
  p.loggedIn = true;
  // Measured: is_active is true for a play we issue ourselves, with the app
  // closed. The other case is exercised explicitly in test 22.
  p.deviceActive = true;
  // no daemon socket and no sound card in the harness
  p.sendCommand = function (payload) { logs.push('cmd ' + JSON.stringify(payload)); };
  p.requestAlsaYield = function () { logs.push('yield requested'); };
  p.clearAlsaYield = function () { logs.push('yield cleared'); };
  p.alsaHeldByUs = function () { return false; };
  p.updateQuality = function () {};
  p.fetchAudioSpec = function () {};
  return p;
}

// A queue holding one Spotify row at position 0, which is what
// queueRowIsCurrent checks the start deadline against.
function armQueue(p, uri) {
  const sm = p.context.coreCommand.stateMachine;
  sm.currentPosition = 0;
  sm.playQueue.arrayQueue = [{
    uri: uri,
    service: 'soloist_connect',
    name: 'Spotify track',
    title: 'Spotify track',
    artist: '',
    album: '',
    albumart: '/albumart',
    duration: 0,
  }];
  return sm;
}

const OURS = 'spotify:track:3Che0Dm9dlytqujcprVAwE';
const ROLLED = 'spotify:track:567e29TDzLwZwfDuEpGTwo';

const item = {
  uri: OURS,
  entity_type: 'track',
  decorations: {
    identity: { name: 'Heat Waves' },
    visual_identity: { cover: [
      { url: 'small.jpg', size: 'small' },
      { url: 'large.jpg', size: 'large' },
    ] },
    parent: { entity: { uri: 'spotify:album:0E2xXn23qVmfx9ThZjWFBE', decorations: { identity: { name: 'Dreamland' } } } },
    creators: [
      { entity: { decorations: { identity: { name: 'Glass Animals' } } } },
      { entity: { decorations: { identity: { name: 'iann dior' } } } },
    ],
    playback: { duration_ms: 175301 },
  },
};

const rolledItem = JSON.parse(JSON.stringify(item));
rolledItem.uri = ROLLED;
rolledItem.decorations.identity.name = 'Something Else';
rolledItem.decorations.playback.duration_ms = 142000;

function evt(status, uri, positionMs, contextUri, useItem, isActive) {
  return {
    type: 'playback_state',
    status: status,
    item: useItem,
    context: { uri: contextUri, entity_type: 'track', decorations: {} },
    position: { position_ms: positionMs, timestamp_ms: Date.now(), speed: status === 'playing' ? 1 : 0 },
    is_active: isActive === undefined ? true : isActive,
  };
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('PASS ' + name);
  } else {
    failures++;
    console.log('FAIL ' + name + (detail ? '  ' + detail : ''));
  }
}

// 1. metadata parser
{
  const p = newPlugin();
  const m = p.itemMeta(item);
  check('itemMeta title', m.title === 'Heat Waves', m.title);
  check('itemMeta artist', m.artist === 'Glass Animals, iann dior', m.artist);
  check('itemMeta album', m.album === 'Dreamland', m.album);
  check('itemMeta duration', m.durationMs === 175301, String(m.durationMs));
  check('itemMeta art prefers large', m.albumart === 'large.jpg', m.albumart);
}

async function main() {
  // 2. explodeUri before and after the cache has seen the track
  {
    const p = newPlugin();
    const out = await p.explodeUri(OURS);
    check('explodeUri unseen returns one row', out && out.length === 1);
    check('explodeUri unseen is honest', out[0].name === 'Spotify track', out[0].name);
    check('explodeUri carries service', out[0].service === 'soloist_connect', out[0].service);

    p.cacheItem(item);
    const out2 = await p.explodeUri(OURS);
    check('explodeUri cached name', out2[0].name === 'Heat Waves', out2[0].name);
    check('explodeUri cached duration s', out2[0].duration === 175, String(out2[0].duration));

    const bad = await p.explodeUri('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
    check('explodeUri refuses playlist', Array.isArray(bad) && bad.length === 0);
  }

  // 3. clearAddPlayTrack enters queue mode and does not go volatile
  {
    const p = newPlugin();
    p.cacheItem(item);
    await p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    check('queue mode entered', p.queueMode === true);
    check('queue uri recorded', p.queueUri === OURS);
    check('not volatile', p.volatileSet === false);
    check('core not volatile', p.context.coreCommand.stateMachine.isVolatile === false);
    check('play sent with uri', logs.some((l) => l === 'cmd {"command":"play","uri":"' + OURS + '"}'));
    check('metadata prefilled from cache', p.state.title === 'Heat Waves', p.state.title);
  }

  // 4. no session -> the row is skipped, core gets a stop
  {
    const p = newPlugin();
    p.loggedIn = false;
    pushed.length = 0;
    nextCalls.length = 0;
    await p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    await new Promise((r) => setImmediate(r));
    check('skip does not publish stop', pushed.length === 0,
      JSON.stringify(pushed[0] || null));
    check('skip advances with next()', nextCalls.length === 1, String(nextCalls.length));
    check('skip left queue mode', p.queueMode === false);
  }

  // 5. mid-track buffering is not the end of the row
  {
    const p = newPlugin();
    p.cacheItem(item);
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    const consumed = p.checkQueueRow(evt('buffering', OURS, 305, OURS, item), OURS);
    check('mid-track buffering ignored', consumed === false && p.queueMode === true);
  }

  // 6. the real end-of-row event from the trace
  {
    const p = newPlugin();
    p.cacheItem(item);
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    p.state.duration = 175;
    pushed.length = 0;
    const consumed = p.checkQueueRow(evt('buffering', OURS, 175301, OURS, item), OURS);
    check('end of row consumed', consumed === true);
    check('end of row published stop', pushed.length === 1 && pushed[0].status === 'stop',
      JSON.stringify(pushed[0] || null));
    check('end of row paused soloist', logs.some((l) => l === 'cmd {"command":"pause"}'));
    check('end of row yielded alsa', logs.some((l) => l === 'yield requested'));
    check('end of row is once only',
      p.checkQueueRow(evt('buffering', OURS, 175301, OURS, item), OURS) === false &&
      pushed.length === 1);
    check('end of row left queue mode', p.queueMode === false);
  }

  // 7. the roll into autoplay, if the buffering event were missed
  {
    const p = newPlugin();
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    pushed.length = 0;
    const consumed = p.checkQueueRow(evt('buffering', ROLLED, 0, OURS, rolledItem), ROLLED);
    check('roll consumed', consumed === true);
    check('roll published stop', pushed.length === 1 && pushed[0].status === 'stop');
  }

  // 8. the phone starting a playlist ends queue mode, does not end the row
  {
    const p = newPlugin();
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    pushed.length = 0;
    const consumed = p.checkQueueRow(
      evt('playing', ROLLED, 0, 'spotify:playlist:37i9dQZEVXcUnNfzphGkKK', rolledItem), ROLLED);
    check('foreign context not consumed', consumed === false);
    check('foreign context left queue mode', p.queueMode === false);
    check('foreign context did not report stop', pushed.length === 0);
  }

  // 9. idle mapping differs by mode
  {
    const p = newPlugin();
    p.state.status = 'play';
    check('idle stays play in connect mode', p.mapStatus('idle') === 'play');
    p.queueMode = true;
    check('idle is stop in queue mode', p.mapStatus('idle') === 'stop');
  }

  // 10. queue_changed harvests metadata for later rows
  {
    const p = newPlugin();
    p.handleEvent({ type: 'queue_changed', previous: [{ item: item }], upcoming: [{ item: rolledItem }] });
    check('cached from queue_changed previous', p.trackCache.has(OURS));
    check('cached from queue_changed upcoming', p.trackCache.has(ROLLED));
  }

  // 11. the seek path works in both modes
  //
  // Every one of these used to be gated on volatileSet, so in a queue row the
  // seek command was never sent and a jump was never republished: the bar
  // moved and the audio did not.
  {
    const p = newPlugin();
    p.seekCoalesceMs = () => 0;
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    logs.length = 0;
    p.seek(90000);
    check('queue mode sends seek to soloist',
      logs.some((l) => l === 'cmd {"command":"seek","position_ms":90000}'),
      logs.join(' | '));

    p.state.status = 'play';
    p.state.duration = 175;
    p.positionAnchor = { position_ms: 10000, timestamp_ms: Date.now(), speed: 1 };
    pushed.length = 0;
    p.handleEvent({
      type: 'position_sync',
      position: { position_ms: 90000, timestamp_ms: Date.now(), speed: 1 },
    });
    check('queue mode republishes a seek jump',
      pushed.length === 1 && Math.abs(pushed[0].seek - 90000) < 500,
      JSON.stringify(pushed[0] || null));

    check('ownership is true in queue mode', p.owningPlayback() === true);
    p.queueMode = false;
    check('ownership is false when we own nothing', p.owningPlayback() === false);
    p.volatileSet = true;
    check('ownership is true in connect mode', p.owningPlayback() === true);
  }

  // 12. the queue row is filled from the daemon's metadata
  //
  // In queue mode the UI reads the queue row, not our published state, and
  // explodeUri can only fill that row from URIs Soloist has already named. A
  // track it has never mentioned queued with no artwork and duration 0.
  {
    const p = newPlugin();
    const sm = p.context.coreCommand.stateMachine;
    sm.currentPosition = 0;
    sm.playQueue.arrayQueue = [{
      uri: OURS,
      service: 'soloist_connect',
      name: 'Spotify track',
      title: 'Spotify track',
      artist: '',
      album: '',
      albumart: '/albumart',
      duration: 0,
    }];
    queuePushes.length = 0;
    queueSaves = 0;
    startPlaybackTimerCalls = 0;
    sm.currentSongDuration = 0;
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    p.applyItem(item);
    const row = sm.playQueue.arrayQueue[0];
    check('queue row name filled', row.name === 'Heat Waves', row.name);
    check('queue row artist filled', row.artist === 'Glass Animals, iann dior', row.artist);
    check('queue row album filled', row.album === 'Dreamland', row.album);
    check('queue row albumart filled', row.albumart === 'large.jpg', row.albumart);
    check('queue row duration filled', row.duration === 175, String(row.duration));
    check('queue push emitted', queuePushes.length === 1, String(queuePushes.length));
    check('queue saved', queueSaves === 1, String(queueSaves));
    check('duration written onto the running timer',
      sm.currentSongDuration === 175000, String(sm.currentSongDuration));
    check('startPlaybackTimer not called', startPlaybackTimerCalls === 0,
      String(startPlaybackTimerCalls));

    queuePushes.length = 0;
    p.applyItem(item);
    check('unchanged row does not push again', queuePushes.length === 0);
  }

  // 13. a row that is not ours is never touched
  {
    const p = newPlugin();
    const sm = p.context.coreCommand.stateMachine;
    sm.currentPosition = 0;
    sm.playQueue.arrayQueue = [{
      uri: 'mnt/INTERNAL/Adele/21/Don\'t You Remember.mp3',
      service: 'mpd',
      name: 'Don\'t You Remember',
      albumart: '/albumart?cacheid=113',
      duration: 243,
    }];
    queuePushes.length = 0;
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    p.applyItem(item);
    check('foreign row untouched', sm.playQueue.arrayQueue[0].name === 'Don\'t You Remember');
    check('foreign row no push', queuePushes.length === 0);
  }

  // 14. Connect mode never writes to the queue
  {
    const p = newPlugin();
    const sm = p.context.coreCommand.stateMachine;
    sm.currentPosition = 0;
    sm.playQueue.arrayQueue = [{ uri: OURS, service: 'soloist_connect', name: 'Spotify track', duration: 0 }];
    queuePushes.length = 0;
    p.volatileSet = true;
    p.applyItem(item);
    check('connect mode leaves the queue alone',
      sm.playQueue.arrayQueue[0].name === 'Spotify track' && queuePushes.length === 0);
  }

  // 15. a row that never starts does not hang the mixed list
  //
  // A play issued while another device holds the Connect session is accepted
  // and then produces no local playback and no event. Without the deadline the
  // queue waits for a row that will never start.
  {
    const p = newPlugin();
    armQueue(p, OURS);
    p.queueStartTimeoutMs = () => 40;
    pushed.length = 0;
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    check('start deadline armed', p.queueStartTimer !== null);
    await new Promise((r) => setTimeout(r, 90));
    check('stalled row reported stop', pushed.length === 1 && pushed[0].status === 'stop',
      JSON.stringify(pushed[0] || null));
    check('stalled row cleared its timer', p.queueStartTimer === null);
    check('stalled row left queue mode', p.queueMode === false);
  }

  // 16. a row that does start cancels the deadline
  {
    const p = newPlugin();
    armQueue(p, OURS);
    p.queueStartTimeoutMs = () => 40;
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    p.checkQueueRow(evt('playing', OURS, 500, OURS, item), OURS);
    check('playing cancels the deadline', p.queueStartTimer === null);
    pushed.length = 0;
    await new Promise((r) => setTimeout(r, 90));
    check('started row is not skipped', pushed.length === 0 && p.queueMode === true);
  }

  // 16b. a deadline must not outlive the row it was armed for
  //
  // Core does not call our stop() on an advance, so a timer armed for one row
  // can fire while a different row is playing. Firing then reports a stop for
  // whatever core is on now, skipping an innocent track.
  {
    const p = newPlugin();
    const sm = armQueue(p, OURS);
    p.queueStartTimeoutMs = () => 40;
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    // core moves on without telling us
    sm.currentPosition = 1;
    sm.playQueue.arrayQueue.push({ uri: 'mnt/local.mp3', service: 'mpd', duration: 100 });
    pushed.length = 0;
    await new Promise((r) => setTimeout(r, 90));
    check('stale deadline reports nothing', pushed.length === 0,
      JSON.stringify(pushed[0] || null));
  }

  // 17. the session moving to another device ends the row, it does not reclaim
  //
  // Reclaiming here ran takeOverPlayback, which calls volumioStop and grabs the
  // device while core was already starting the next row. MPD opened a card we
  // had not released and failed with "Device or resource busy".
  {
    const p = newPlugin();
    let takeovers = 0;
    p.takeOverPlayback = function () { takeovers++; };
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    p.state.status = 'play';
    p.state.duration = 175;
    pushed.length = 0;
    logs.length = 0;
    const consumed = p.checkQueueRow(
      evt('paused', ROLLED, 0, 'spotify:station:track:' + OURS.split(':')[2], rolledItem, false),
      ROLLED);
    check('transfer away is consumed', consumed === true);
    check('transfer away reported stop', pushed.length === 1 && pushed[0].status === 'stop',
      JSON.stringify(pushed[0] || null));
    check('transfer away yielded before core moves on',
      logs.indexOf('yield requested') !== -1);
    check('transfer away did not reclaim', takeovers === 0, String(takeovers));
    check('transfer away left queue mode', p.queueMode === false);
  }

  // 18. the session starting here still reclaims
  {
    const p = newPlugin();
    let takeovers = 0;
    p.takeOverPlayback = function () { takeovers++; };
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    p.state.status = 'play';
    pushed.length = 0;
    const consumed = p.checkQueueRow(
      evt('playing', ROLLED, 0, 'spotify:playlist:37i9dQZEVXcUnNfzphGkKK', rolledItem, true),
      ROLLED);
    check('local takeover not consumed', consumed === false);
    check('local takeover reclaims', takeovers === 1, String(takeovers));
    check('local takeover reports no stop', pushed.length === 0);
  }

  // 19. the settings gate
  {
    const off = newPlugin({ queue_playback: false });
    armQueue(off, OURS);
    pushed.length = 0;
    logs.length = 0;
    off.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    check('queue playback off does not enter queue mode', off.queueMode === false);
    check('queue playback off sends no play',
      !logs.some((l) => l.indexOf('"command":"play"') !== -1), logs.join(' | '));
    nextCalls.length = 0;
    await new Promise((r) => setImmediate(r));
    check('queue playback off advances with next()', nextCalls.length === 1,
      String(nextCalls.length));
    check('queue playback off does not publish stop', pushed.length === 0,
      JSON.stringify(pushed[0] || null));

    const on = newPlugin({ queue_playback: true });
    armQueue(on, OURS);
    logs.length = 0;
    on.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    check('queue playback on plays the row',
      on.queueMode === true &&
      logs.some((l) => l === 'cmd {"command":"play","uri":"' + OURS + '"}'));
  }

  // 20. remote playback keeps a row that produced no local audio
  {
    const p = newPlugin({ queue_playback: true, queue_remote_playback: true });
    armQueue(p, OURS);
    p.queueStartTimeoutMs = () => 40;
    pushed.length = 0;
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    await new Promise((r) => setTimeout(r, 90));
    check('remote playback does not skip the row', pushed.length === 0,
      JSON.stringify(pushed[0] || null));
    check('remote playback leaves queue mode', p.queueMode === false);
    check('remote playback does not claim ownership', p.owningPlayback() === false);
  }

  // 21. only daemon settings restart the daemon
  {
    const p = newPlugin();
    const stored = {
      api_key: 'k', device_name: 'Volumio', initial_volume: 50,
      cache_size_mb: 1024, cache_location: 'disk', buffer_ms: 500,
      output_trim_db: 0, verbose_logging: false,
      queue_playback: false, queue_remote_playback: false,
    };
    p.config = { get: (key) => stored[key] };
    const same = Object.assign({}, stored);
    check('queue switches alone do not restart',
      p.daemonSettingsChanged(Object.assign(same, { queue_playback: true })) === false);
    check('a daemon setting does restart',
      p.daemonSettingsChanged(Object.assign({}, stored, { buffer_ms: 400 })) === true);
  }

  // 21b. a section save posts only its own fields
  {
    const p = newPlugin();
    const stored = {
      api_key: 'k', device_name: 'hanger', initial_volume: 35,
      cache_size_mb: 1024, cache_location: 'disk', buffer_ms: 300,
      output_trim_db: 4, verbose_logging: true,
      retain_api_key: true, queue_playback: false, queue_remote_playback: false,
      seek_coalesce_ms: 200, inactive_hold_ms: 2000,
      quality_retry_ms: 300, quality_retry_max: 2,
    };
    p.config = { get: (key) => stored[key] };
    const result = p.validateSettings({
      queue_playback: true,
      queue_remote_playback: false,
    });
    check('partial save is accepted', result.ok === true, result.message);
    check('partial save keeps the API key', result.values.api_key === 'k');
    check('partial save keeps volume', result.values.initial_volume === 35);
    check('partial save keeps trim', result.values.output_trim_db === 4);
    check('partial save keeps verbose', result.values.verbose_logging === true);
    check('partial save sets queue on', result.values.queue_playback === true);
    check('partial queue save does not restart',
      p.daemonSettingsChanged(result.values) === false);
  }

  // 22. a row is not sent to a session we do not hold
  //
  // play is routed to whichever device holds the session. Sending one while the
  // session is elsewhere starts audio on that device, and the later skip does
  // not take it back: on hanger the track played on the other device anyway.
  {
    const off = newPlugin({ queue_playback: true, queue_remote_playback: false });
    armQueue(off, OURS);
    off.deviceActive = false;
    logs.length = 0;
    pushed.length = 0;
    off.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    check('remote off sends no play to another device',
      !logs.some((l) => l.indexOf('"command":"play"') !== -1), logs.join(' | '));
    check('remote off does not enter queue mode', off.queueMode === false);
    nextCalls.length = 0;
    await new Promise((r) => setImmediate(r));
    check('remote off advances with next()', nextCalls.length === 1,
      String(nextCalls.length));
    check('remote off does not publish stop', pushed.length === 0,
      JSON.stringify(pushed[0] || null));

    const on = newPlugin({ queue_playback: true, queue_remote_playback: true });
    armQueue(on, OURS);
    on.deviceActive = false;
    logs.length = 0;
    on.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    check('remote on does send the play',
      logs.some((l) => l === 'cmd {"command":"play","uri":"' + OURS + '"}'),
      logs.join(' | '));
  }

  // 23. the pre-check reads the reported flag, not the delayed one
  //
  // The hold is deliberate: is_active blinks false during a seek and comes
  // back, and yielding on that blink ends the Connect session, so `active` only
  // drops after inactive_hold_ms. That is why it is the wrong flag to ask
  // before starting a queue row, and why deviceActive exists alongside it.
  {
    const p = newPlugin();
    p.inactiveHoldMs = () => 2000;
    // Establish the state the hold protects: the device is active and playing.
    p.updateActive({ is_active: true });
    check('both flags true while active', p.active === true && p.deviceActive === true);

    // The blink.
    p.updateActive({ is_active: false });
    check('reported flag is immediate', p.deviceActive === false);
    check('held flag still lags', p.active === true);
    check('hold is armed', p.inactiveHoldTimer !== null);

    // It comes back before the hold expires, which is the case the hold exists
    // for: the session must not end.
    p.updateActive({ is_active: true });
    check('blink did not end the session',
      p.active === true && p.deviceActive === true && p.inactiveHoldTimer === null);
    p.clearInactiveHold();
  }

  // 23b. with no hold, both flags drop together
  {
    const p = newPlugin();
    p.inactiveHoldMs = () => 0;
    p.unsetVolatile = function () {};
    p.updateActive({ is_active: true });
    p.updateActive({ is_active: false });
    check('no hold means no lag', p.active === false && p.deviceActive === false);
  }

  // 24. album context with our item is not a session move
  {
    const p = newPlugin();
    let takeovers = 0;
    p.takeOverPlayback = function () { takeovers++; };
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    pushed.length = 0;
    const consumed = p.checkQueueRow(
      evt('playing', OURS, 500, 'spotify:album:0E2xXn23qVmfx9ThZjWFBE', item, true),
      OURS);
    check('album context not consumed', consumed === false);
    check('album context stays in queue mode', p.queueMode === true);
    check('album context does not reclaim', takeovers === 0, String(takeovers));
    check('album context reports no stop', pushed.length === 0);
  }

  // 25. idle ends the row only after it has started
  {
    const p = newPlugin();
    armQueue(p, OURS);
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    pushed.length = 0;
    const early = p.checkQueueRow(evt('idle', '', 0, '', { uri: '' }, true), '');
    check('idle before start is ignored', early === false && p.queueMode === true);
    check('idle before start reports no stop', pushed.length === 0);

    p.checkQueueRow(evt('playing', OURS, 500, OURS, item), OURS);
    const late = p.checkQueueRow(evt('idle', OURS, 175301, OURS, item), OURS);
    check('idle after start is consumed', late === true);
    check('idle after start published stop', pushed.length === 1 && pushed[0].status === 'stop',
      JSON.stringify(pushed[0] || null));
  }

  // 26. playback_changed idle after start ends the row
  {
    const p = newPlugin();
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    p.state.uri = OURS;
    p.state.status = 'play';
    p.clearQueueStartTimer();
    pushed.length = 0;
    p.handleEvent({ type: 'playback_changed', status: 'idle' });
    check('playback_changed idle published stop',
      pushed.length === 1 && pushed[0].status === 'stop',
      JSON.stringify(pushed[0] || null));
    check('playback_changed idle left queue mode', p.queueMode === false);
  }

  // 27. stop is not published while we still hold the card
  {
    const p = newPlugin();
    p.clearAddPlayTrack({ uri: OURS, service: 'soloist_connect' });
    p.state.duration = 175;
    let held = true;
    p.alsaHeldByUs = function () { return held; };
    pushed.length = 0;
    p.checkQueueRow(evt('buffering', OURS, 175301, OURS, item), OURS);
    check('held card defers the stop', pushed.length === 0 && p.queueMode === false);
    held = false;
    await new Promise((r) => setTimeout(r, 40));
    check('stop publishes after the card is free',
      pushed.length === 1 && pushed[0].status === 'stop',
      JSON.stringify(pushed[0] || null));
  }

  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
}

main();
