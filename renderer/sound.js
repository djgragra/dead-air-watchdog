// Audible alarm (hidden window, always alive, so it sounds with the main window closed): two-tone beeps with a gap
// between bursts (see the help text: with a microphone input the gaps keep a loudspeaker from looking like "audio is
// back"). One sound for all inputs. The audio is measured by the engine (a separate program), not here.
(function () {
  'use strict';
  const api = window.soundApi;

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
  api.ready();
})();
