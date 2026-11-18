// Messages from the audio engine (a separate Rust process), as the monitor wants them. Kept apart from main.js so the
// shape of each message is covered by a test: getting the argument order wrong once left inputs stuck "offline".
//   { event: 'levels', inputs: { <id>: { rms: [dB, dB], peak: [dB, dB] } } }   every 100 ms, only inputs that delivered audio
//   { event: 'fault', id, reason, detail }    an input cannot deliver (device gone, stream down ...)
//   { event: 'ok', id }                       it delivers again
export function routeEngineEvent(monitor, ev) {
  switch (ev?.event) {
    case 'levels': return monitor.onLevels(ev.inputs);
    case 'fault': return monitor.onFault(ev.id, ev.reason);
    case 'ok': return monitor.onOk(ev.id);
    default: return undefined;
  }
}
