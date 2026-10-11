// What the alerts already said, kept across restarts in its own file (alert-state.json).
// Never part of a backup. Written atomically; a missing or damaged file means "nothing told yet".
import fs from 'node:fs';
import path from 'node:path';

export function createAlertState({ file }) {
  let data = load();

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const u = raw?.updateNotice;
      const told = u && typeof u.version === 'string' && u.told && typeof u.told === 'object' ? u.told : {};
      return { updateNotice: { version: typeof u?.version === 'string' ? u.version : '', told: { ...told } } };
    } catch {
      return { updateNotice: { version: '', told: {} } };
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...data }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  return {
    // was this version already announced on this channel ('desktop' | 'telegram' | 'email')?
    isTold: (version, channel) => data.updateNotice.version === version && data.updateNotice.told[channel] === true,
    markTold(version, channel) {
      if (data.updateNotice.version !== version) data.updateNotice = { version, told: {} }; // a newer version starts again
      data.updateNotice.told[channel] = true;
      save();
    }
  };
}
