// Visual comparison of the original screenshot with the exported Figma render.
// A pixel counts as mismatched only if no pixel within `radius` in the other
// image is close in colour, so 1px anti-aliasing shifts are tolerated.

import type { Pixels } from "./color";
import type { Rect } from "./types";

export interface DiffResult {
  /** Fraction of compared pixels that mismatch (0..1). */
  mismatch: number;
  /** Original dimmed to grey, mismatched pixels painted red. Same size as `region`. */
  mask: Pixels;
}

function close(a: Pixels, ia: number, b: Pixels, x: number, y: number, radius: number, threshold2: number): boolean {
  for (let dy = -radius; dy <= radius; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= b.height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= b.width) continue;
      const ib = (yy * b.width + xx) * 4;
      const dr = a.data[ia] - b.data[ib];
      const dg = a.data[ia + 1] - b.data[ib + 1];
      const db = a.data[ia + 2] - b.data[ib + 2];
      if (dr * dr + dg * dg + db * db <= threshold2) return true;
    }
  }
  return false;
}

/** Compare `region` of two same-sized images. */
export function diffImages(original: Pixels, rendered: Pixels, region?: Rect, threshold = 48, radius = 1): DiffResult {
  const r = region ?? { x: 0, y: 0, w: original.width, h: original.height };
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(original.width, rendered.width, Math.ceil(r.x + r.w));
  const y1 = Math.min(original.height, rendered.height, Math.ceil(r.y + r.h));
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const mask: Pixels = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  const t2 = threshold * threshold;
  let bad = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * original.width + x) * 4;
      const j = (y * rendered.width + x) * 4;
      const ok = close(original, i, rendered, x, y, radius, t2) && close(rendered, j, original, x, y, radius, t2);
      const m = ((y - y0) * w + (x - x0)) * 4;
      if (ok) {
        const g = 160 + (original.data[i] + original.data[i + 1] + original.data[i + 2]) / 9.6;
        mask.data[m] = mask.data[m + 1] = mask.data[m + 2] = Math.min(255, g);
      } else {
        bad++;
        mask.data[m] = 255;
        mask.data[m + 1] = 0;
        mask.data[m + 2] = 0;
      }
      mask.data[m + 3] = 255;
    }
  }
  return { mismatch: w * h > 0 ? bad / (w * h) : 0, mask };
}
