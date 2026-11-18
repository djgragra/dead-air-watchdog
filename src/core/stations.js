// Stations: the streams of one radio shown together. A station has a name and a logo; its streams (inputs with
// `stationId`) have their own name and logo when they set them, and take the station's when they do not. Pure: no DOM, no
// settings file; the window and the tests give it plain lists.
//
// The view "by station" shows one tile for each station (its logo, its name, the song title and the level of the `featured`
// stream, the worst state of its streams). The streams open under it when the person clicks it, and by themselves
// when one of them is in dead air. The alerts stay one for each stream, with the name of the stream.

// The colour of a group: the station and its streams share it (a stripe and the name), so that they are seen as one group. Never green,
// yellow, red or blue: those are the states.
export const PALETTE = ['#a78bfa', '#22d3ee', '#f472b6', '#fb923c', '#2dd4bf', '#e879f9', '#94a3b8', '#d6a56b'];
export const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
// A colour for each station that has none: the first of the palette that no other station uses (the palette goes round when all are used).
export function assignColors(stations) {
  const taken = new Set(stations.filter((s) => isColor(s.color)).map((s) => s.color.toLowerCase()));
  let round = 0;
  for (const st of stations) {
    if (isColor(st.color)) continue;
    let pick = PALETTE.find((c) => !taken.has(c));
    if (!pick) { pick = PALETTE[round % PALETTE.length]; round++; }
    st.color = pick;
    taken.add(pick);
  }
  return stations;
}

// How bad a state is: the station shows the worst state of its streams (same order as the overall state in src/monitor.js).
export const PRIORITY = { alarm: 4, counting: 3, starting: 2, ok: 1 };

// The logo of a stream: its own, or its station's ('' = none). Ids of the logo store (src/logos.js).
export const logoIdFor = (input, station) => input.logo || (station && station.logo) || '';

// The streams of each station in the order of the inputs, and the inputs that are in none. A station without streams is left out.
export function groupInputs(stations, inputs) {
  const byId = new Map((stations || []).map((s) => [s.id, s]));
  const groups = new Map();
  const loose = [];
  for (const input of inputs) {
    const st = input.stationId && byId.get(input.stationId);
    if (!st) {
      loose.push(input);
      continue;
    }
    if (!groups.has(st.id)) groups.set(st.id, { station: st, members: [] });
    groups.get(st.id).members.push(input);
  }
  return { groups: [...groups.values()], loose };
}

// What a station is as a whole, from the state of each of its streams (`stateOf(id)` = 'ok' | 'counting' | 'alarm' | ...).
//   state    the worst: alarm, counting (yellow: a silence is being counted, the alarm has not started), starting, ok; anything
//            else (paused, off, idle) when none of the streams is in one of those
//   counts   how many streams are in each state
export function aggregate(members, stateOf) {
  const counts = { total: members.length, alarm: 0, counting: 0, starting: 0, ok: 0, other: 0 };
  let state = 'idle';
  let rank = 0;
  for (const m of members) {
    const s = stateOf(m.id);
    if (PRIORITY[s]) counts[s]++;
    else counts.other++;
    if ((PRIORITY[s] || 0) > rank) {
      rank = PRIORITY[s];
      state = s;
    }
  }
  if (rank === 0) {
    const first = members.length ? stateOf(members[0].id) : 'idle';
    state = members.length && members.every((m) => stateOf(m.id) === first) ? first || 'idle' : 'idle';
  }
  return { state, counts };
}

// The stream a closed station shows: the one chosen if it is still one of its streams, else the first.
export const featuredOf = (station, members) => (members.find((m) => m.id === station.featured) || members[0] || null)?.id || '';

// A station is open when the person opened it, and always while one of its streams is in dead air (so that nobody has to look
// for the one that fell). `manual`: { [stationId]: true } for the ones the person opened.
export const isOpen = (station, agg, manual) => agg.counts.alarm > 0 || !!(manual && manual[station.id]);

// When many stations fall together (a network failure), opening all of them would fill the screen with streams: the first
// MAX_AUTO_OPEN open by themselves, the others stay closed (red, with their count) and the window says "+N more".
export const MAX_AUTO_OPEN = 4;

// What to draw, in order: a station where its first stream is in the list of inputs, an input that is in no station where it is.
// Each item: { kind: 'station', station, members, agg, featured, open, capped } (capped: in dead air but kept closed, see MAX_AUTO_OPEN) or { kind: 'input', input }.
export function viewItems(stations, inputs, stateOf, manual, maxAuto = MAX_AUTO_OPEN) {
  const { groups } = groupInputs(stations, inputs);
  const byStation = new Map(groups.map((g) => [g.station.id, g]));
  const done = new Set();
  const items = [];
  for (const input of inputs) {
    const g = input.stationId && byStation.get(input.stationId);
    if (!g) {
      items.push({ kind: 'input', input });
      continue;
    }
    if (done.has(g.station.id)) continue;
    done.add(g.station.id);
    const agg = aggregate(g.members, stateOf);
    items.push({ kind: 'station', station: g.station, members: g.members, agg, featured: featuredOf(g.station, g.members), open: isOpen(g.station, agg, manual) });
  }
  // the cap: stations opened only because of the dead air, in the order of the view; the ones the person opened stay open
  let auto = 0;
  for (const it of items) {
    if (it.kind !== 'station' || !it.open || (manual && manual[it.station.id])) continue;
    if (++auto > maxAuto) {
      it.open = false;
      it.capped = true;
    }
  }
  return items;
}
