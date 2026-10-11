// Moves one item of a list up (delta -1) or down (+1). Returns a new list; at the ends nothing moves.
export function moveItem(list, index, delta) {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length || !delta) return [...list];
  const out = [...list];
  [out[index], out[to]] = [out[to], out[index]];
  return out;
}
