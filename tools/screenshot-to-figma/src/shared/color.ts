import type { DesignNode, DesignTree, Rect } from "./types";

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Normalise #RGB, #RGBA, #RRGGBB, #RRGGBBAA (with or without #) to upper-case #RRGGBB[AA]. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let h = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(h)) return null;
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  h = h.toUpperCase();
  if (h.length === 8 && h.endsWith("FF")) h = h.slice(0, 6);
  return `#${h}`;
}

/** Parse a normalised hex colour into 0..1 channels. */
export function hexToRgba(hex: string): RGBA {
  const h = (normalizeHex(hex) ?? "#000000").slice(1);
  const c = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: c(0), g: c(2), b: c(4), a: h.length === 8 ? c(6) : 1 };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const p = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${p(r)}${p(g)}${p(b)}`.toUpperCase();
}

/** Minimal ImageData-like view of the original screenshot (RGBA bytes). */
export interface Pixels {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

type RGB = [number, number, number];

const inside = (x: number, y: number, r: Rect) =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** Sample a rectangle on a grid of roughly `maxSamples` points, skipping `exclude` rects. */
function sample(px: Pixels, rect: Rect, exclude: Rect[], maxSamples: number): RGB[] {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(px.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(px.height, Math.ceil(rect.y + rect.h));
  const area = (x1 - x0) * (y1 - y0);
  if (area <= 0) return [];
  const step = Math.max(1, Math.sqrt(area / maxSamples));
  const out: RGB[] = [];
  for (let y = y0 + step / 2; y < y1; y += step) {
    for (let x = x0 + step / 2; x < x1; x += step) {
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      if (exclude.some((e) => inside(ix, iy, e))) continue;
      const i = (iy * px.width + ix) * 4;
      out.push([px.data[i], px.data[i + 1], px.data[i + 2]]);
    }
  }
  return out;
}

/** Most common colour (4-bit buckets, averaged) and the share of samples it covers. */
export function dominantColor(
  px: Pixels,
  rect: Rect,
  exclude: Rect[] = [],
  maxSamples = 900,
): { hex: string; rgb: RGB; share: number } | null {
  const samples = sample(px, rect, exclude, maxSamples);
  if (samples.length === 0) return null;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (const [r, g, b] of samples) {
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n++;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  let best = { n: 0, r: 0, g: 0, b: 0 };
  for (const bucket of buckets.values()) if (bucket.n > best.n) best = bucket;
  const rgb: RGB = [best.r / best.n, best.g / best.n, best.b / best.n];
  return { hex: rgbToHex(...rgb), rgb, share: best.n / samples.length };
}

const dist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Estimate the ink colour of text inside `rect`: the pixels furthest from the
 * background (anti-aliased edges sit in between), averaged over the top 15%.
 */
export function textInkColor(px: Pixels, rect: Rect, background?: RGB): string | null {
  const samples = sample(px, rect, [], 2500);
  if (samples.length < 4) return null;
  // Glyphs rarely cover most of their box, so the local mode is the background.
  const local = dominantColor(px, rect);
  const bg = local && local.share > 0.4 ? local.rgb : background ?? local?.rgb;
  if (!bg) return null;
  const scored = samples
    .map((c) => ({ c, d: dist(c, bg) }))
    .filter((s) => s.d > 48)
    .sort((a, b) => b.d - a.d);
  if (scored.length === 0) return null;
  const top = scored.slice(0, Math.max(1, Math.ceil(scored.length * 0.15)));
  const avg = top.reduce<RGB>(
    (acc, { c }) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]],
    [0, 0, 0],
  );
  return rgbToHex(avg[0] / top.length, avg[1] / top.length, avg[2] / top.length);
}

function inset(rect: Rect, by: number): Rect {
  const d = Math.min(by, rect.w / 4, rect.h / 4);
  return { x: rect.x + d, y: rect.y + d, w: rect.w - 2 * d, h: rect.h - 2 * d };
}

/**
 * Replace model-estimated colours with colours measured from the screenshot:
 * solid fills of containers/shapes and text ink. Mutates the tree.
 */
export function refineColors(tree: DesignTree, px: Pixels): void {
  const full: Rect = { x: 0, y: 0, w: px.width, h: px.height };
  const rootBg = dominantColor(px, full, tree.children.map((c) => c.src));
  if (rootBg && rootBg.share > 0.5) tree.background = rootBg.hex;

  const visit = (node: DesignNode, parentBg: RGB) => {
    let bg = parentBg;
    const opaqueFill = node.fill && node.fill.length === 7 && !node.gradient;
    if (opaqueFill && (node.type === "frame" || node.type === "rectangle" || node.type === "ellipse")) {
      // Stay clear of anti-aliased edges, borders and rounded corners.
      const pad = Math.max(2, (node.strokeWidth ?? 0) * 2, (node.radius ?? 0) * 0.3 * (node.src.w / Math.max(1, node.w)));
      const measured = dominantColor(px, inset(node.src, pad), node.children.map((c) => c.src));
      if (measured && measured.share > 0.6) {
        node.fill = measured.hex;
        bg = measured.rgb;
      } else {
        const rgba = hexToRgba(node.fill!);
        bg = [rgba.r * 255, rgba.g * 255, rgba.b * 255];
      }
    }
    if (node.type === "text" && node.text) {
      const ink = textInkColor(px, node.src, bg);
      if (ink) node.text.color = ink;
    }
    for (const child of node.children) visit(child, bg);
  };

  const treeBg = hexToRgba(tree.background);
  for (const child of tree.children) visit(child, [treeBg.r * 255, treeBg.g * 255, treeBg.b * 255]);
}
