// Clean backgrounds for posters and photo-heavy designs. Text, icons and
// outlines drawn over a photo become live Figma layers, so they are erased from
// the photo crop (otherwise editing the text would leave a ghost copy). Icons
// over photos are extracted as transparent PNGs by colour matting.

import { surroundingColor, type Pixels } from "./color";
import type { DesignNode, DesignTree, Rect } from "./types";

type RGB = [number, number, number];

const dist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const at = (px: Pixels, x: number, y: number): RGB => {
  const i = (y * px.width + x) * 4;
  return [px.data[i], px.data[i + 1], px.data[i + 2]];
};
const hexRgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;

export interface Overlay {
  kind: "ink" | "outline";
  /** Region in source pixels. */
  rect: Rect;
  /** Ink colour for text/icons (null: estimate from pixels). */
  ink: RGB | null;
  strokeWidth?: number;
}

/** Estimate the ink colour of an icon: the pixels that differ most from the area around it. */
export function estimateInk(px: Pixels, r: Rect): RGB | null {
  const bg = surroundingColor(px, r)?.rgb;
  if (!bg) return null;
  const samples: { c: RGB; d: number }[] = [];
  for (let y = Math.floor(r.y); y < Math.min(px.height, r.y + r.h); y++) {
    for (let x = Math.floor(r.x); x < Math.min(px.width, r.x + r.w); x++) {
      const c = at(px, x, y);
      samples.push({ c, d: dist(c, bg) });
    }
  }
  samples.sort((a, b) => b.d - a.d);
  const top = samples.slice(0, Math.max(1, Math.ceil(samples.length * 0.1)));
  if (top[0].d < 40) return null;
  return [0, 1, 2].map((k) => top.reduce((s, t) => s + t.c[k], 0) / top.length) as RGB;
}

/**
 * Local background around ink: a box blur of the image that ignores `core`
 * pixels (normalised convolution with summed-area tables).
 */
function localBackground(px: Pixels, core: Uint8Array, radius: number): Float32Array {
  const W = px.width;
  const H = px.height;
  const sat = new Float64Array((W + 1) * (H + 1) * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const keep = core[i] ? 0 : 1;
      const o = ((y + 1) * (W + 1) + (x + 1)) * 4;
      const up = (y * (W + 1) + (x + 1)) * 4;
      const left = ((y + 1) * (W + 1) + x) * 4;
      const diag = (y * (W + 1) + x) * 4;
      for (let k = 0; k < 3; k++) sat[o + k] = px.data[i * 4 + k] * keep + sat[up + k] + sat[left + k] - sat[diag + k];
      sat[o + 3] = keep + sat[up + 3] + sat[left + 3] - sat[diag + 3];
    }
  }
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(H, y + radius + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(W, x + radius + 1);
      const a = (y0 * (W + 1) + x0) * 4, b = (y0 * (W + 1) + x1) * 4, c = (y1 * (W + 1) + x0) * 4, d = (y1 * (W + 1) + x1) * 4;
      const n = sat[d + 3] - sat[b + 3] - sat[c + 3] + sat[a + 3];
      for (let k = 0; k < 3; k++) out[(y * W + x) * 3 + k] = n > 0 ? (sat[d + k] - sat[b + k] - sat[c + k] + sat[a + k]) / n : px.data[(y * W + x) * 4 + k];
    }
  }
  return out;
}

function dilateMask(mask: Uint8Array, W: number, H: number, times: number): Uint8Array {
  let cur = mask;
  for (let k = 0; k < times; k++) {
    const next = cur.slice();
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (!cur[y * W + x] && ((x > 0 && cur[y * W + x - 1]) || (x < W - 1 && cur[y * W + x + 1]) || (y > 0 && cur[(y - 1) * W + x]) || (y < H - 1 && cur[(y + 1) * W + x])))
          next[y * W + x] = 1;
    cur = next;
  }
  return cur;
}

/**
 * 1 where an overlay's own pixels (glyphs, icon strokes, outlines) cover the
 * image. Glyph cores are pixels close to the ink colour; anti-aliased edges
 * are pixels pulled measurably towards the ink from the local background
 * (estimated per pixel with the cores excluded), so nearby light haze or
 * texture is not mistaken for text.
 */
export function overlayMask(px: Pixels, overlays: Overlay[], dilate = 1): Uint8Array {
  const { width: W, height: H } = px;
  const core = new Uint8Array(W * H);
  const mask = new Uint8Array(W * H);
  const inks: { o: Overlay; ink: RGB; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const o of overlays) {
    const x0 = Math.max(0, Math.floor(o.rect.x) - 2);
    const y0 = Math.max(0, Math.floor(o.rect.y) - 2);
    const x1 = Math.min(W, Math.ceil(o.rect.x + o.rect.w) + 2);
    const y1 = Math.min(H, Math.ceil(o.rect.y + o.rect.h) + 2);
    if (o.kind === "outline") {
      const band = Math.ceil((o.strokeWidth ?? 1) + 1.5);
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++)
          if (x - x0 < band || x1 - 1 - x < band || y - y0 < band || y1 - 1 - y < band) {
            core[y * W + x] = 1;
            mask[y * W + x] = 1;
          }
      continue;
    }
    const ink = o.ink ?? estimateInk(px, o.rect);
    if (!ink) continue;
    inks.push({ o, ink, x0, y0, x1, y1 });
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (dist(at(px, x, y), ink) < 60) core[y * W + x] = 1;
  }
  // Background estimated away from the glyphs (shadows/glows hug the text).
  const halo = dilateMask(core, W, H, 8);
  const bg = localBackground(px, halo, 18);
  // Shadows/glows hug the glyphs; further out, deviations are real photo structure.
  const hug = dilateMask(core, W, H, 4);
  for (const { ink, x0, y0, x1, y1 } of inks) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        if (core[i]) {
          mask[i] = 1;
          continue;
        }
        const p = at(px, x, y);
        const b: RGB = [bg[i * 3], bg[i * 3 + 1], bg[i * 3 + 2]];
        const d: RGB = [ink[0] - b[0], ink[1] - b[1], ink[2] - b[2]];
        const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        if (len2 < 30 * 30) continue;
        const alpha = ((p[0] - b[0]) * d[0] + (p[1] - b[1]) * d[1] + (p[2] - b[2]) * d[2]) / len2;
        // Anti-aliased edges (pulled towards the ink), or a shadow/glow close
        // to the glyphs (any clear deviation from the local background).
        if (alpha > 0.12 || (hug[i] && alpha < -0.06 && dist(p, b) > 12)) mask[i] = 1;
      }
    }
  }
  return dilateMask(mask, W, H, dilate);
}

/**
 * Fill masked pixels from their surroundings: a coarse-to-fine pyramid fill
 * followed by diffusion. Suited to the smooth backgrounds text usually sits on.
 */
export function inpaint(px: Pixels, mask: Uint8Array): Pixels {
  type Level = { w: number; h: number; c: Float32Array; known: Uint8Array };
  const W = px.width;
  const H = px.height;
  const base: Level = { w: W, h: H, c: new Float32Array(W * H * 3), known: new Uint8Array(W * H) };
  for (let i = 0; i < W * H; i++) {
    base.known[i] = mask[i] ? 0 : 1;
    for (let k = 0; k < 3; k++) base.c[i * 3 + k] = px.data[i * 4 + k];
  }
  const levels = [base];
  while (true) {
    const prev = levels[levels.length - 1];
    if (prev.known.every((v) => v === 1) || (prev.w <= 2 && prev.h <= 2)) break;
    const w = Math.max(1, Math.ceil(prev.w / 2));
    const h = Math.max(1, Math.ceil(prev.h / 2));
    const lv: Level = { w, h, c: new Float32Array(w * h * 3), known: new Uint8Array(w * h) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let n = 0;
        const sum = [0, 0, 0];
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const sx = 2 * x + dx;
            const sy = 2 * y + dy;
            if (sx >= prev.w || sy >= prev.h || !prev.known[sy * prev.w + sx]) continue;
            n++;
            for (let k = 0; k < 3; k++) sum[k] += prev.c[(sy * prev.w + sx) * 3 + k];
          }
        if (n > 0) {
          lv.known[y * w + x] = 1;
          for (let k = 0; k < 3; k++) lv.c[(y * w + x) * 3 + k] = sum[k] / n;
        }
      }
    }
    levels.push(lv);
  }
  // Gauss-Seidel smoothing of a level's unknown pixels (known ones fixed).
  const smooth = (lv: Level, iterations: number) => {
    const holes: number[] = [];
    for (let i = 0; i < lv.w * lv.h; i++) if (!lv.known[i]) holes.push(i);
    for (let it = 0; it < iterations; it++) {
      for (const i of holes) {
        const x = i % lv.w;
        const y = (i - x) / lv.w;
        let n = 0;
        const sum = [0, 0, 0];
        for (const j of [x > 0 ? i - 1 : -1, x < lv.w - 1 ? i + 1 : -1, y > 0 ? i - lv.w : -1, y < lv.h - 1 ? i + lv.w : -1]) {
          if (j < 0) continue;
          n++;
          for (let k = 0; k < 3; k++) sum[k] += lv.c[j * 3 + k];
        }
        for (let k = 0; k < 3; k++) lv.c[i * 3 + k] = sum[k] / n;
      }
    }
  };

  // Coarse to fine: unknown pixels start from the bilinear value of the level
  // above and are smoothed at every scale (multigrid-style harmonic fill), so
  // large holes come out as smooth gradients instead of blocks.
  for (let l = levels.length - 2; l >= 0; l--) {
    const lv = levels[l];
    const up = levels[l + 1];
    for (let y = 0; y < lv.h; y++) {
      for (let x = 0; x < lv.w; x++) {
        const i = y * lv.w + x;
        if (lv.known[i]) continue;
        const fx = Math.min(up.w - 1, Math.max(0, (x - 0.5) / 2));
        const fy = Math.min(up.h - 1, Math.max(0, (y - 0.5) / 2));
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const x1 = Math.min(up.w - 1, x0 + 1), y1 = Math.min(up.h - 1, y0 + 1);
        const tx = fx - x0, ty = fy - y0;
        for (let k = 0; k < 3; k++) {
          const v =
            up.c[(y0 * up.w + x0) * 3 + k] * (1 - tx) * (1 - ty) +
            up.c[(y0 * up.w + x1) * 3 + k] * tx * (1 - ty) +
            up.c[(y1 * up.w + x0) * 3 + k] * (1 - tx) * ty +
            up.c[(y1 * up.w + x1) * 3 + k] * tx * ty;
          lv.c[i * 3 + k] = v;
        }
      }
    }
    if (l > 0) smooth(lv, 12);
  }
  // Diffusion on the masked pixels for seamless edges.
  const holes: number[] = [];
  for (let i = 0; i < W * H; i++) if (mask[i]) holes.push(i);
  for (let iter = 0; iter < 30; iter++) {
    for (const i of holes) {
      const x = i % W;
      const y = (i - x) / W;
      let n = 0;
      const s = [0, 0, 0];
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j < 0) continue;
        n++;
        for (let k = 0; k < 3; k++) s[k] += base.c[j * 3 + k];
      }
      for (let k = 0; k < 3; k++) base.c[i * 3 + k] = s[k] / n;
    }
  }
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    for (let k = 0; k < 3; k++) data[i * 4 + k] = base.c[i * 3 + k];
    data[i * 4 + 3] = px.data[i * 4 + 3];
  }
  return { data, width: W, height: H };
}

/**
 * Transparent icon from a photo: colour = ink, alpha = how far each pixel
 * moved from the clean background towards the ink colour.
 */
export function matte(original: Pixels, clean: Pixels, r: Rect, ink: RGB): Pixels | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const w = Math.max(1, Math.min(original.width - x0, Math.ceil(r.x + r.w) - x0));
  const h = Math.max(1, Math.min(original.height - y0, Math.ceil(r.y + r.h) - y0));
  const data = new Uint8ClampedArray(w * h * 4);
  // Alpha only near the actual strokes (pixels close to the ink colour), so
  // background structure that differs from the inpainted fill is not picked up.
  const core = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (dist(at(original, x0 + x, y0 + y), ink) < 90) core[y * w + x] = 1;
  const near = dilateMask(core, w, h, 2);
  let weak = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!near[y * w + x]) continue;
      const p = at(original, x0 + x, y0 + y);
      const b = at(clean, x0 + x, y0 + y);
      const d: RGB = [ink[0] - b[0], ink[1] - b[1], ink[2] - b[2]];
      const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      if (len2 < 40 * 40) weak++;
      const a = len2 > 0 ? ((p[0] - b[0]) * d[0] + (p[1] - b[1]) * d[1] + (p[2] - b[2]) * d[2]) / len2 : 0;
      const o = (y * w + x) * 4;
      data[o] = ink[0];
      data[o + 1] = ink[1];
      data[o + 2] = ink[2];
      // Below ~10% is background noise, not glyph coverage: drop it so the
      // layer carries no haze when moved.
      const alpha = a < 0.1 ? 0 : Math.min(1, (a - 0.1) / 0.85);
      data[o + 3] = Math.round(alpha * 255);
    }
  }
  // Too little contrast against the background for a trustworthy matte.
  if (weak > w * h * 0.3) return null;
  // Single-colour test: ink composited over the clean background must rebuild
  // the original. Multi-colour artwork fails and stays a bitmap.
  let bad = 0;
  let inked = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const a = data[o + 3] / 255;
      const p = at(original, x0 + x, y0 + y);
      const b = at(clean, x0 + x, y0 + y);
      const rebuilt: RGB = [ink[0] * a + b[0] * (1 - a), ink[1] * a + b[1] * (1 - a), ink[2] * a + b[2] * (1 - a)];
      if (a > 0.05 || dist(p, b) > 40) inked++;
      if (dist(rebuilt, p) > 48) bad++;
    }
  }
  if (inked > 0 && bad / inked > 0.08) return null;
  return { data, width: w, height: h };
}

interface Painted {
  node: DesignNode;
  order: number;
  ancestors: Set<string>;
}

function paintOrder(tree: DesignTree): Painted[] {
  const out: Painted[] = [];
  const walk = (list: DesignNode[], anc: string[]) => {
    for (const n of list) {
      out.push({ node: n, order: out.length, ancestors: new Set(anc) });
      walk(n.children, [...anc, n.id]);
    }
  };
  walk(tree.children, []);
  return out;
}

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export interface CleanPlan {
  /** Image node ids whose crops should come from the cleaned pixels. */
  images: Set<string>;
  /** Icon node ids drawn over an image, with their ink colour, to extract by matting. */
  icons: Map<string, RGB>;
  overlays: Overlay[];
}

/** Find text, icons and outlines painted on top of images. */
export function planCleanup(tree: DesignTree, px: Pixels): CleanPlan {
  const painted = paintOrder(tree);
  const images = painted.filter((p) => p.node.type === "image");
  const plan: CleanPlan = { images: new Set(), icons: new Map(), overlays: [] };
  for (const p of painted) {
    const n = p.node;
    // Text shown as an image needs the clean background behind it for matting.
    if (n.type === "text" && n.text?.raster) plan.overlays.push({ kind: "ink", rect: n.src, ink: hexRgb(n.text.color) });
    const below = images.filter((img) => img.order < p.order && !p.ancestors.has(img.node.id) && intersects(img.node.src, n.src));
    // Icons are matted (for vector tracing) on any background.
    if (n.type === "icon" && below.length === 0) {
      const ink = estimateInk(px, n.src);
      if (ink) {
        plan.overlays.push({ kind: "ink", rect: n.src, ink });
        plan.icons.set(n.id, ink);
      }
      continue;
    }
    if (below.length === 0) continue;
    if (n.type === "text" && n.text) {
      if (!n.text.raster) plan.overlays.push({ kind: "ink", rect: n.src, ink: hexRgb(n.text.color) });
    } else if (n.type === "icon") {
      const ink = estimateInk(px, n.src);
      if (!ink) continue;
      plan.overlays.push({ kind: "ink", rect: n.src, ink });
      plan.icons.set(n.id, ink);
    } else if ((n.type === "frame" || n.type === "rectangle") && n.stroke && !n.fill && !n.gradient) {
      plan.overlays.push({ kind: "outline", rect: n.src, ink: null, strokeWidth: (n.strokeWidth ?? 1) * (n.src.w / Math.max(1, n.w)) });
    } else continue;
    for (const img of below) plan.images.add(img.node.id);
  }
  return plan;
}
