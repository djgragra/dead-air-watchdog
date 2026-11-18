// Which logos a clean-up of the logo store must keep, and how the files of earlier versions are given to their inputs.
// Pure (tests in dev/logos.test.js).
//
// An input shows the logo its `logo` points to, and nothing else: '' is "no logo". Until 0.2.1 the file was named after
// the input (`<input id>.png`); such a file is given to its input once, at the start of the app and after an import
// (`adoptLegacy`), so that removing a logo later really removes it.

// The ids a clean-up must keep: the logo of each input and of each station.
export const keepIds = (inputs, stations = []) => [...new Set([...inputs, ...stations].map((x) => x.logo).filter(Boolean))];

// Inputs without `logo` that own a file of their name get it written down. Returns the new list, or null if nothing changed.
export function adoptLegacy(inputs, existingIds) {
  const have = new Set(existingIds);
  let changed = false;
  const out = inputs.map((i) => {
    if (i.logo || !have.has(i.id)) return i;
    changed = true;
    return { ...i, logo: i.id };
  });
  return changed ? out : null;
}

// Logos that are the same picture stored under several ids (a file for each input of a station, made before the library
// existed): one is kept, the inputs that used the others point to it, and the others are to be deleted. The one kept is
// the first the inputs use, in the order of the inputs. Stations (their logos) follow the same merge.
// Returns { inputs, stations, remove } or null if there is nothing to merge.
export function mergeDuplicates(inputs, hashes, stations = []) {
  const keep = new Map(); // hash -> id kept
  const remap = new Map(); // id -> id kept
  const order = [...new Set([...inputs, ...stations].map((x) => x.logo).filter(Boolean).concat(Object.keys(hashes)))];
  for (const id of order) {
    const h = hashes[id];
    if (!h) continue;
    if (!keep.has(h)) keep.set(h, id);
    else remap.set(id, keep.get(h));
  }
  if (!remap.size) return null;
  const follow = (x) => (remap.has(x.logo) ? { ...x, logo: remap.get(x.logo) } : x);
  return { inputs: inputs.map(follow), stations: stations.map(follow), remove: [...remap.keys()] };
}
