// Chromium lets one window hold at most 10 streams at a time (and at most 6 connections to the same
// server, which is the usual case: many mounts of one Icecast). Beyond that the extra streams never
// connect and look like "dead air". The way out is more than one audio engine window, each with its own
// connection pool (its own session partition). This splits the inputs between them.
export const STREAMS_PER_ENGINE = 6;

// list: the inputs the audio engine must open, in the order of the settings. Returns one list per engine
// window: the first holds the sound card (it uses no connection) and the first streams; every further
// window holds the next `perEngine` streams. A window is only needed when there are more than
// `perEngine` streams, so a small setup keeps its single window exactly as before.
export function shardInputs(list, perEngine = STREAMS_PER_ENGINE) {
  const shards = [[]];
  let streams = 0;
  for (const input of list) {
    if (input.type === 'device') {
      shards[0].push(input);
      continue;
    }
    const k = Math.floor(streams++ / perEngine);
    (shards[k] ||= []).push(input);
  }
  return shards;
}
