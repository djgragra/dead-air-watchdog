// Wall display: how many columns and rows give the biggest tiles for n inputs in a width x height area.
// `aspect` is the shape a tile likes (wider than tall). Works for 1 to 32 inputs and any window.
export function wallGrid(n, width, height, aspect = 1.45) {
  if (!(n >= 1) || !(width > 0) || !(height > 0)) return { cols: 1, rows: 1 };
  let best = { cols: 1, rows: n, score: -1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const score = Math.min(width / cols / aspect, height / rows);
    if (score > best.score + 1e-9) best = { cols, rows, score };
  }
  return { cols: best.cols, rows: best.rows };
}
