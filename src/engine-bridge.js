// What the monitor sees as "the engine": sync(list) and stop(), plus the list of sound cards. Behind it is the Rust engine
// (EngineSupervisor). The inputs of the monitor are turned into sources for the engine; cards are looked up in the
// list of devices of the system, which is read again every few seconds while monitoring, so that a card that was not
// there at the start (or an old saved id found again by its label) is opened as soon as it appears.
import { toEngineInputs } from './devices.js';
import { routeEngineEvent } from './engine-events.js';

export function createEngineBridge({ supervisor, getMonitor, getLabel = () => '', getName = () => '', onDevices = () => {}, log = () => {}, refreshMs = 10_000, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let wanted = null; // the list of inputs of the monitor, null = nothing
  let lastSent = '';
  let seq = 0;
  let devices = [];
  let timer = null;

  async function listDevices() {
    const r = await supervisor.request({ cmd: 'list_devices' }, 'devices', 20_000);
    devices = r.devices;
    onDevices(devices);
    return devices;
  }

  async function push() {
    const mine = ++seq;
    if (!wanted) return;
    let list = devices;
    if (wanted.some((i) => i.type === 'device')) {
      try { list = await listDevices(); } catch (err) { log(`device list failed: ${err.message}`, 'warn'); }
    }
    if (mine !== seq || !wanted) return; // a newer list arrived, or monitoring stopped
    const inputs = toEngineInputs(wanted, list, getLabel);
    const key = JSON.stringify(inputs);
    if (key === lastSent) return;
    lastSent = key;
    supervisor.syncInputs(inputs);
  }

  supervisor.on('event', (ev) => {
    // what the engine says about an input is written to the log (the reason and its detail): without it a stream that drops
    // again and again could only be seen on the tile, and the detail (how long, how much was received) was lost
    if (ev?.event === 'fault') log(`${getName(ev.id) || ev.id}: ${ev.reason}${ev.detail ? ` (${ev.detail})` : ''}`, 'warn');
    else if (ev?.event === 'ok') log(`${getName(ev.id) || ev.id}: audio is back`, 'info');
    const monitor = getMonitor();
    if (monitor) routeEngineEvent(monitor, ev);
  });
  supervisor.on('restarted', () => {
    log('audio engine restarted', 'warn');
    getMonitor()?.engineRestarted();
  });
  supervisor.on('exit', (info) => log(`audio engine ended (code ${info.code}, signal ${info.signal})`, 'warn'));

  return {
    sync(list) {
      wanted = list;
      push();
      if (!timer) timer = setIntervalFn(() => push(), refreshMs);
    },
    stop() {
      wanted = null;
      lastSent = '';
      seq++;
      clearIntervalFn(timer);
      timer = null;
      supervisor.stopInputs();
    },
    // [{ deviceId, label, channels }] for the settings window
    async devices() {
      const list = await listDevices();
      return list.map((d) => ({ deviceId: d.id, label: d.name, channels: d.channels }));
    },
    // how many channels a device has (null when unknown)
    async channels(deviceId) {
      const list = devices.length ? devices : await listDevices();
      const d = list.find((x) => (deviceId ? x.id === deviceId : x.default));
      return d ? d.channels : null;
    },
    shutdown() {
      clearIntervalFn(timer);
      timer = null;
      return supervisor.stop();
    }
  };
}
