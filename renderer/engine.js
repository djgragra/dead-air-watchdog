// Audio engine (hidden window). Opens every monitored input (at most one sound card, any number of
// streams), runs each through its own level-meter worklet and reports the levels ~10 times a
// second in one batch. It also reports a "fault" per input when it stops delivering audio
// (device removed, stream down) and keeps trying to reconnect.
(function () {
  'use strict';
  const api = window.engineApi;
  const RETRY_MS = [2000, 5000, 10000, 30000];
  const STALL_MS = 3000;
  const BATCH_MS = 100;

  let ctx = null;
  let ready = null; // promise: worklet module loaded
  let mute = null;
  const pipes = new Map(); // input id -> pipeline
  let batch = {};
  let batchTimer = null;

  const keyOf = (i) => [i.type, i.deviceId, i.channelPair, i.streamUrl].join('|');

  function setFault(p, reason) {
    if (!p.faulted) api.fault(p.id, reason);
    p.faulted = true;
  }
  function setOk(p) {
    if (p.faulted) api.ok(p.id);
    p.faulted = false;
    p.attempts = 0;
  }

  function disconnectAll(p) {
    clearTimeout(p.stallTimer);
    if (p.stream) p.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    p.stream = null;
    if (p.audio) {
      p.audio.onerror = p.audio.onended = p.audio.onstalled = p.audio.onwaiting = p.audio.onplaying = null;
      p.audio.pause();
      p.audio.removeAttribute('src');
      p.audio.load();
    }
    p.audio = null;
    if (p.source) { try { p.source.disconnect(); } catch (e) { /* already disconnected */ } }
    p.source = null;
    p.chain.forEach((n) => { try { n.disconnect(); } catch (e) { /* ignore */ } });
    p.chain = [];
  }

  function destroy(p) {
    p.gen++;
    p.dead = true;
    clearTimeout(p.retryTimer);
    disconnectAll(p);
    if (p.node) { p.node.port.onmessage = null; try { p.node.disconnect(); } catch (e) { /* ignore */ } }
    pipes.delete(p.id);
    delete batch[p.id];
  }

  function scheduleRetry(p, gen, reason) {
    if (gen !== p.gen) return;
    setFault(p, reason);
    clearTimeout(p.retryTimer);
    const delay = RETRY_MS[Math.min(p.attempts++, RETRY_MS.length - 1)];
    p.retryTimer = setTimeout(() => { if (gen === p.gen) connect(p, gen); }, delay);
  }

  async function connectDevice(p, gen) {
    const input = p.input;
    const pair = Math.min(3, Math.max(0, Number(input.channelPair) || 0));
    const needed = pair * 2 + 2;
    const audioConstraints = {
      // The browser must not "improve" the signal: AGC, noise suppression and echo cancellation
      // would change the very level we are measuring.
      echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: needed }
    };
    if (input.deviceId) audioConstraints.deviceId = { exact: input.deviceId };
    const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    if (gen !== p.gen) { s.getTracks().forEach((t) => t.stop()); return; }
    const have = (s.getAudioTracks()[0] && s.getAudioTracks()[0].getSettings().channelCount) || 2;
    if (pair > 0 && have < needed) {
      s.getTracks().forEach((t) => t.stop());
      const e = new Error('device has ' + have + ' channels, ' + needed + ' needed');
      e.name = 'ChannelsUnavailable';
      throw e;
    }
    p.stream = s;
    p.source = ctx.createMediaStreamSource(s);
    if (pair > 0) {
      // measure channels (2p+1, 2p+2) of a multichannel interface
      const splitter = ctx.createChannelSplitter(have);
      const merger = ctx.createChannelMerger(2);
      p.source.connect(splitter);
      splitter.connect(merger, pair * 2, 0);
      splitter.connect(merger, pair * 2 + 1, 1);
      merger.connect(p.node);
      p.chain = [splitter, merger];
    } else {
      p.source.connect(p.node);
    }
    s.getAudioTracks().forEach((t) => { t.onended = () => { if (gen === p.gen) { disconnectAll(p); scheduleRetry(p, gen, 'device-ended'); } }; });
    setOk(p);
  }

  function connectStream(p, gen) {
    disconnectAll(p);
    const audio = new Audio();
    p.audio = audio;
    audio.crossOrigin = 'anonymous'; // without CORS the Web Audio graph would receive silence
    audio.preload = 'none';
    audio.autoplay = true;
    const fail = (reason) => () => { if (gen === p.gen) { disconnectAll(p); scheduleRetry(p, gen, reason); } };
    audio.onerror = fail('stream-error');
    audio.onended = fail('stream-ended');
    audio.onstalled = () => { if (gen === p.gen) setFault(p, 'stream-stalled'); };
    audio.onwaiting = () => {
      clearTimeout(p.stallTimer);
      p.stallTimer = setTimeout(() => { if (gen === p.gen) { disconnectAll(p); scheduleRetry(p, gen, 'stream-stalled'); } }, STALL_MS);
    };
    audio.onplaying = () => { clearTimeout(p.stallTimer); if (gen === p.gen) setOk(p); };
    p.source = ctx.createMediaElementSource(audio);
    p.source.connect(p.node);
    audio.src = p.input.streamUrl;
    const pr = audio.play();
    if (pr && pr.catch) pr.catch(() => { /* surfaced through onerror / stalled */ });
  }

  async function connect(p, gen) {
    try {
      if (!ctx || gen !== p.gen || p.dead) return;
      if (ctx.state === 'suspended') await ctx.resume();
      if (p.input.type === 'stream') connectStream(p, gen);
      else await connectDevice(p, gen);
    } catch (err) {
      scheduleRetry(p, gen, err && err.name ? err.name : 'error');
    }
  }

  async function create(input) {
    const p = { id: input.id, input, key: keyOf(input), gen: 0, dead: false, node: null, source: null, chain: [], stream: null, audio: null, retryTimer: null, stallTimer: null, attempts: 0, faulted: false };
    pipes.set(p.id, p);
    try {
      await ready;
      if (p.dead) return;
      p.node = new AudioWorkletNode(ctx, 'level-meter', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [1] });
      p.node.port.onmessage = (e) => { batch[p.id] = e.data; };
      p.node.connect(mute); // the graph must reach the destination for the worklet to run; the gain keeps it inaudible
      await connect(p, p.gen);
    } catch (err) {
      scheduleRetry(p, p.gen, err && err.name ? err.name : 'engine-error');
    }
  }

  function ensureContext() {
    if (ctx) return;
    ctx = new AudioContext({ latencyHint: 'playback' });
    mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);
    ready = ctx.audioWorklet.addModule('level-worklet.js');
    batchTimer = setInterval(() => {
      if (Object.keys(batch).length) { api.levels(batch); batch = {}; }
    }, BATCH_MS);
  }

  // Makes the open inputs match the list: new ones are opened, removed ones closed, edited ones reopened.
  function sync(list) {
    ensureContext();
    const wanted = new Map(list.map((i) => [i.id, i]));
    for (const p of [...pipes.values()]) {
      const w = wanted.get(p.id);
      if (!w || keyOf(w) !== p.key) destroy(p);
    }
    for (const input of list) if (!pipes.has(input.id)) create(input);
  }

  async function stopAll() {
    for (const p of [...pipes.values()]) destroy(p);
    clearInterval(batchTimer);
    batchTimer = null;
    batch = {};
    if (ctx) { try { await ctx.close(); } catch (e) { /* ignore */ } }
    ctx = null;
    ready = null;
    mute = null;
  }

  async function listDevices() {
    // labels are empty until the user has granted access, so open the default input briefly
    let probe = null;
    try { probe = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); } catch (e) { /* denied: labels stay empty */ }
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    if (probe) probe.getTracks().forEach((t) => t.stop());
    return { granted: !!probe, devices: devices.map((d) => ({ deviceId: d.deviceId, label: d.label })) };
  }

  // ---- audible alarm: two-tone beeps with a gap between bursts (see the help text: with a
  // microphone input the gaps keep a loudspeaker from looking like "audio is back"). One sound
  // for all inputs.
  let sndCtx = null;
  let sndTimer = null;
  let sndStop = null;
  function beep(volume) {
    if (!sndCtx) sndCtx = new AudioContext();
    if (sndCtx.state === 'suspended') sndCtx.resume();
    const t0 = sndCtx.currentTime;
    [[880, 0], [660, 0.18]].forEach(([hz, off]) => {
      const osc = sndCtx.createOscillator();
      const g = sndCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      g.gain.setValueAtTime(0, t0 + off);
      g.gain.linearRampToValueAtTime(volume, t0 + off + 0.02);
      g.gain.setValueAtTime(volume, t0 + off + 0.15);
      g.gain.linearRampToValueAtTime(0, t0 + off + 0.17);
      osc.connect(g).connect(sndCtx.destination);
      osc.start(t0 + off);
      osc.stop(t0 + off + 0.18);
    });
  }
  function soundOff() {
    clearInterval(sndTimer);
    clearTimeout(sndStop);
    sndTimer = sndStop = null;
  }
  function soundOn(volume, testMs) {
    soundOff();
    const v = Math.min(1, Math.max(0.05, Number(volume) || 0.6));
    beep(v);
    sndTimer = setInterval(() => beep(v), 1200); // 0.36 s of sound, 0.84 s of silence
    if (testMs) sndStop = setTimeout(soundOff, testMs);
  }
  api.onSound((msg) => (msg.on ? soundOn(msg.volume, msg.test ? 3000 : 0) : soundOff()));

  api.onSync((list) => sync(list));
  api.onStop(() => stopAll());
  api.onRpc(async (msg) => {
    try {
      if (msg.op === 'devices') api.rpcResult({ id: msg.id, result: await listDevices() });
      else api.rpcResult({ id: msg.id, error: 'unknown-op' });
    } catch (err) {
      api.rpcResult({ id: msg.id, error: err && err.name ? err.name : String(err) });
    }
  });
  navigator.mediaDevices.addEventListener('devicechange', () => {
    // a device that was missing may be back: retry now instead of waiting for the timer
    for (const p of pipes.values()) {
      if (p.faulted && p.input.type === 'device' && ctx) { clearTimeout(p.retryTimer); connect(p, p.gen); }
    }
  });
  api.ready();
})();
