// Does a logo have a transparent edge? A logo drawn on a transparent background (most PNG, SVG, WebP) needs no box behind
// it on the tile; one that fills its whole picture (a JPG, a PNG with its own background) keeps a light box so that it is
// readable on a dark tile. Pure: the pixels come from a canvas in the window.
// rgba: Uint8ClampedArray of w*h*4. Looks at the outer 2 pixels all round.
export function hasTransparentEdge(rgba, w, h, { alphaMax = 24, share = 0.15, ring = 2 } = {}) {
  if (!rgba || !w || !h || rgba.length < w * h * 4) return false;
  let seen = 0;
  let clear = 0;
  for (let y = 0; y < h; y++) {
    const edgeRow = y < ring || y >= h - ring;
    for (let x = 0; x < w; x++) {
      if (!edgeRow && x >= ring && x < w - ring) continue;
      seen++;
      if (rgba[(y * w + x) * 4 + 3] <= alphaMax) clear++;
    }
  }
  return seen > 0 && clear / seen >= share;
}
