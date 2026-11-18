// Sound cards as the app sees them. The engine lists devices with a stable id of the system and a name; a saved input
// keeps `deviceId` (and `deviceLabel`, the name it had when it was chosen). A configuration saved by the previous
// version (or imported from a backup of it) holds the ids of the browser engine, which mean nothing to the new engine:
// those inputs are found again by their label, and only if exactly one device has it (a card is never swapped for
// another one: when nothing matches, the input stays "not found").

// "Default - Microphone (Realtek)" and "Microphone (Realtek)" are the same card; so are "Scarlett 2i2 (1235:8210)" and
// "Scarlett 2i2": the browser adds the default marker and the USB ids.
export function normalizeLabel(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/^(default|communications)\s*-\s*/, '')
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// devices: [{ id, name, channels }]. Returns { id, via }: via is 'default' (empty id: the system default input), 'id'
// (the saved id is a device of this system), 'label' (found again by its name) or null (not found, id is null).
export function resolveDevice(deviceId, deviceLabel, devices) {
  if (!deviceId) return { id: '', via: 'default' };
  if (devices.some((d) => d.id === deviceId)) return { id: deviceId, via: 'id' };
  const want = normalizeLabel(deviceLabel);
  if (!want) return { id: null, via: null };
  const same = devices.filter((d) => normalizeLabel(d.name) === want);
  if (same.length === 1) return { id: same[0].id, via: 'label' };
  return { id: null, via: null };
}

// The sources the engine opens for the list of inputs of the monitor (see engineInput in monitor.js).
export function toEngineInputs(list, devices, labelOf = () => '') {
  return list.map((i) => {
    if (i.type === 'stream') return { id: i.id, source: { kind: 'stream', url: i.streamUrl } };
    const mono = Math.min(16, Math.max(0, Number(i.channelMono) || 0)); // 1-16 = one single channel
    const pair = Math.min(7, Math.max(0, Number(i.channelPair) || 0));
    const found = resolveDevice(i.deviceId || '', labelOf(i.id), devices);
    return {
      id: i.id,
      source: {
        kind: 'device',
        device_id: found.id ?? i.deviceId, // not found: the engine is asked for what was saved and reports "not found"
        channel_start: mono > 0 ? mono - 1 : pair * 2,
        channel_count: mono > 0 ? 1 : 2
      }
    };
  });
}
