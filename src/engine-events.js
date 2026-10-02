// Messages from the hidden audio engine, as the monitor wants them. Kept apart from main.js so the
// argument order (input id first) is covered by a test: getting it wrong once left inputs stuck "offline".
export function engineHandlers(monitor) {
  return {
    'engine:levels': (batch) => monitor.onLevels(batch),
    'engine:fault': (id, reason) => monitor.onFault(id, reason),
    'engine:ok': (id) => monitor.onOk(id)
  };
}
