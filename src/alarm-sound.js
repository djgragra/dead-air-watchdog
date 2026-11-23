// The audible alarm of the whole app: when it sounds, when it calms down, when it is silenced.
// It sounds from the moment an alarm starts. With `continuousMin` > 0 it sounds without a break for that long and then
// calms down: one beep every `repeatMin` minutes (0 = silence) for as long as the alarm lasts. A new alarm starts it again
// from the beginning. The user can silence it (button, tray, shortcut, Telegram): it then stays silent until a new alarm.
// The sound window plays what this module tells it: { on, volume } (continuous beeps, off) or { beep, volume } (one burst).
// Everything with side effects is injected, so tests drive it with a fake clock.

export function createAlarmSound({ send, getSound, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval, onChange = () => {} }) {
  let active = false; // an alarm is open (told by the monitor)
  let muted = false;
  let startedAt = 0; // when the alarm that sounds now started (a new alarm starts it again)
  let playing = false; // continuous sound sent to the window
  let nextBeepAt = null; // calm phase: when the next single beep is due
  let timer = null;

  const cfg = () => getSound();
  const sounding = () => active && !muted && !!cfg().enabled; // what the window shows as "the sound is on" (also in the calm phase)

  function phase(t) {
    if (!sounding()) return 'off';
    const c = cfg();
    const cont = Number(c.continuousMin) || 0;
    if (cont <= 0 || t - startedAt < cont * 60_000) return 'continuous';
    return Number(c.repeatMin) > 0 ? 'periodic' : 'quiet';
  }

  function apply() {
    const t = now();
    const c = cfg();
    const ph = phase(t);
    if (ph === 'continuous') {
      nextBeepAt = null;
      if (!playing) {
        playing = true;
        send({ on: true, volume: c.volume });
      }
    } else {
      if (playing) {
        playing = false;
        send({ on: false, volume: c.volume });
      }
      if (ph === 'periodic') {
        if (nextBeepAt === null) nextBeepAt = startedAt + Number(c.continuousMin) * 60_000; // the first one when the continuous sound ends
        if (t >= nextBeepAt) {
          send({ beep: true, volume: c.volume });
          nextBeepAt = t + Number(c.repeatMin) * 60_000;
        }
      } else nextBeepAt = null;
    }
    // a timer only while there is something to time
    const need = sounding() && Number(c.continuousMin) > 0;
    if (need && !timer) {
      timer = setIntervalFn(apply, 1000);
      timer?.unref?.();
    } else if (!need && timer) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  return {
    // the monitor: an alarm is open (true, at every new alarm) or none is (false)
    setActive(on) {
      active = !!on;
      if (on) {
        muted = false;
        startedAt = now();
        nextBeepAt = null;
      }
      apply();
      onChange();
    },
    // silenced by the user: returns true if something was sounding
    mute() {
      const was = sounding();
      muted = true;
      apply();
      onChange();
      return was;
    },
    // the settings changed
    refresh() {
      apply();
      onChange();
    },
    // the sound window was (re)started: it knows nothing
    resend() {
      playing = false;
      apply();
    },
    sounding,
    phase: () => phase(now()),
    stop() {
      if (timer) clearIntervalFn(timer);
      timer = null;
    }
  };
}
