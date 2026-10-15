// Groups the alerts of inputs that fail (or come back) together into one message, so that eight streams going down
// at once do not send eight emails. Pure apart from the injected timer and sender; time is injected so a test can
// drive it with a fake clock.
//
//   submit(kind, item, single)  kind: 'alarm' | 'recovered'.  item: what the list line needs (input, cause, start, ...).
//                               single: { subject, text }, the normal message of this one input.
//
// Per kind there is one window. With `firstNow` the first alert of a window is sent at once (a lone failure is never
// delayed) and the others of the same window are collected; when the window closes they go out as ONE message that
// lists them (a single leftover goes out as its own normal message). Without `firstNow` every alert waits for the
// window to close. `flush()` sends whatever is waiting (monitoring stopped, app quitting).
export function createGrouper({ getConfig, send, buildGroup, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const windows = new Map(); // kind -> { queue: [{ item, single }], timer }

  function close(kind) {
    const w = windows.get(kind);
    if (!w) return;
    clearTimer(w.timer);
    windows.delete(kind);
    if (w.queue.length === 1) send(w.queue[0].single);
    else if (w.queue.length > 1) send(buildGroup(kind, w.queue.map((q) => q.item)));
  }

  function submit(kind, item, single) {
    const cfg = getConfig();
    if (!cfg?.enabled) return send(single);
    let w = windows.get(kind);
    if (!w) {
      w = { queue: [], timer: null };
      windows.set(kind, w);
      w.timer = setTimer(() => close(kind), Math.max(1, cfg.windowSec) * 1000);
      if (cfg.firstNow) return send(single); // the window is open; the first alert does not wait
    }
    w.queue.push({ item, single });
  }

  function flush() {
    for (const kind of [...windows.keys()]) close(kind);
  }

  return { submit, flush, pending: () => [...windows.values()].reduce((n, w) => n + w.queue.length, 0) };
}
