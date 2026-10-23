// Pixel snapping: replace model-estimated boxes with boxes measured from the
// screenshot. Containers snap their edges to where their fill (or border)
// ends; text, images and icons snap to the tight bounding box of their "ink"
// (pixels that differ from the background behind them). Text boxes become
// glyph bounds, which the renderer aligns using Figma's render bounds.

import { dominantColor, hexToRgba, type Pixels } from "./color";
import type { Analysis, FlatNode, Rect } from "./types";

type RGB = [number, number, number];

const dist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function at(px: Pixels, x: number, y: number): RGB {
  const ix = Math.min(px.width - 1, Math.max(0, Math.round(x)));
  const iy = Math.min(px.height - 1, Math.max(0, Math.round(y)));
  const i = (iy * px.width + ix) * 4;
  return [px.data[i], px.data[i + 1], px.data[i + 2]];
}

const hexRgb = (hex: string): RGB => {
  const c = hexToRgba(hex);
  return [c.r * 255, c.g * 255, c.b * 255];
};

const isOpaqueHex = (hex: string | null): hex is string => !!hex && hex.length === 7;

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function bandFor(r: Rect): number {
  return Math.max(2, Math.min(10, Math.round(0.15 * Math.min(r.w, r.h))));
}

type Side = "left" | "right" | "top" | "bottom";

/**
 * Locate one edge of a box. `isInside(c)` says whether a pixel belongs to the
 * element. Scans perpendicular to the edge over a band and returns the median
 * transition coordinate, or null when the edge is not clearly visible.
 */
function findEdge(px: Pixels, r: Rect, side: Side, band: number, isInside: (c: RGB) => boolean, spread: number): number | null {
  const horizontal = side === "left" || side === "right";
  const length = horizontal ? r.h : r.w;
  const origin = horizontal ? r.y : r.x;
  const edge = side === "left" ? r.x : side === "right" ? r.x + r.w : side === "top" ? r.y : r.y + r.h;
  const outward = side === "left" || side === "top" ? -1 : 1;
  const lines = Math.max(3, Math.min(9, Math.floor(length * 2 * spread)));
  const found: number[] = [];

  for (let k = 0; k < lines; k++) {
    const t = origin + length * (0.5 - spread + (2 * spread * (k + 0.5)) / lines);
    // Walk from inside to outside; the edge is where pixels stop belonging.
    let last: number | null = null;
    for (let d = -band; d <= band; d++) {
      const p = edge + outward * d;
      const c = horizontal ? at(px, p - (outward > 0 ? 1 : 0), t) : at(px, t, p - (outward > 0 ? 1 : 0));
      if (isInside(c)) last = p;
      else if (last !== null) break;
    }
    if (last !== null) found.push(last);
  }
  if (found.length < Math.ceil(lines * 0.6)) return null;
  return median(found);
}

function snapBox(px: Pixels, node: FlatNode, inside: RGB[]): Rect {
  const r: Rect = { x: node.x, y: node.y, w: node.w, h: node.h };
  const band = bandFor(r);
  const pill = (node.radius ?? 0) > Math.min(r.w, r.h) * 0.25 || node.type === "ellipse";
  const spread = pill ? 0.08 : 0.25;
  const isInside = (c: RGB) => inside.some((ref) => dist(c, ref) < 22);

  const left = findEdge(px, r, "left", band, isInside, spread);
  const right = findEdge(px, r, "right", band, isInside, spread);
  const top = findEdge(px, r, "top", band, isInside, spread);
  const bottom = findEdge(px, r, "bottom", band, isInside, spread);

  const x1 = left ?? r.x;
  const x2 = right ?? r.x + r.w;
  const y1 = top ?? r.y;
  const y2 = bottom ?? r.y + r.h;
  if (x2 - x1 < 1 || y2 - y1 < 1) return r;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Contiguous runs of `profile[i] > 0`, as [start, end) pairs. */
function runs(profile: number[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  profile.forEach((v, i) => {
    if (v > 0 && start < 0) start = i;
    if (v === 0 && start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  });
  if (start >= 0) out.push([start, profile.length]);
  return out;
}

/** Union of runs that overlap [lo, hi). */
function spanOverlapping(rs: [number, number][], lo: number, hi: number): [number, number] | null {
  let a = Infinity;
  let b = -Infinity;
  for (const [s, e] of rs) {
    if (e > lo && s < hi) {
      a = Math.min(a, s);
      b = Math.max(b, e);
    }
  }
  return a < b ? [a, b] : null;
}

/** Tight bounding box of pixels differing from `bg`, near the node's box. */
export function inkBox(px: Pixels, r: Rect, bg: RGB, clip: Rect, threshold = 40): Rect | null {
  const band = bandFor(r);
  const x0 = Math.max(0, Math.floor(Math.max(clip.x, r.x - band)));
  const y0 = Math.max(0, Math.floor(Math.max(clip.y, r.y - band)));
  const x1 = Math.min(px.width, Math.ceil(Math.min(clip.x + clip.w, r.x + r.w + band)));
  const y1 = Math.min(px.height, Math.ceil(Math.min(clip.y + clip.h, r.y + r.h + band)));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;

  // Local background: the most common colour in the search window.
  const local = dominantColor(px, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  const ref = local && local.share > 0.35 ? local.rgb : bg;

  const cols = new Array(x1 - x0).fill(0);
  const rows = new Array(y1 - y0).fill(0);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * px.width + x) * 4;
      const c: RGB = [px.data[i], px.data[i + 1], px.data[i + 2]];
      if (dist(c, ref) > threshold) {
        cols[x - x0]++;
        rows[y - y0]++;
      }
    }
  }
  const xs = spanOverlapping(runs(cols), Math.floor(r.x) - x0, Math.ceil(r.x + r.w) - x0);
  const ys = spanOverlapping(runs(rows), Math.floor(r.y) - y0, Math.ceil(r.y + r.h) - y0);
  if (!xs || !ys) return null;
  return { x: x0 + xs[0], y: y0 + ys[0], w: xs[1] - xs[0], h: ys[1] - ys[0] };
}

function iou(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** Order nodes so every parent is processed before its children. */
function parentsFirst(nodes: FlatNode[]): FlatNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = (n: FlatNode): number => {
    let d = 0;
    let cur = n;
    while (cur.parent !== "root" && byId.has(cur.parent) && d < 64) {
      cur = byId.get(cur.parent)!;
      d++;
    }
    return d;
  };
  return [...nodes].sort((a, b) => depth(a) - depth(b));
}

/** Snap every node's box to the screenshot. `a` is in source pixels. Returns a new Analysis. */
export function snapToPixels(a: Analysis, px: Pixels): Analysis {
  const nodes = a.nodes.map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const full: Rect = { x: 0, y: 0, w: px.width, h: px.height };
  const screenBg = hexRgb(a.background);

  const backgroundOf = (n: FlatNode): RGB => {
    let cur = byId.get(n.parent);
    while (cur) {
      if (isOpaqueHex(cur.fill) && !cur.gradient) return hexRgb(cur.fill);
      cur = byId.get(cur.parent);
    }
    return screenBg;
  };
  const parentRect = (n: FlatNode): Rect => {
    const p = byId.get(n.parent);
    return p ? { x: p.x, y: p.y, w: p.w, h: p.h } : full;
  };

  for (const n of parentsFirst(nodes)) {
    const before: Rect = { x: n.x, y: n.y, w: n.w, h: n.h };
    const bg = backgroundOf(n);
    let next: Rect | null = null;

    if (n.type === "frame" || n.type === "rectangle" || n.type === "ellipse" || n.type === "line") {
      const inside: RGB[] = [];
      if (isOpaqueHex(n.fill) && !n.gradient && dist(hexRgb(n.fill), bg) > 24) inside.push(hexRgb(n.fill));
      if (isOpaqueHex(n.stroke) && dist(hexRgb(n.stroke), bg) > 24) inside.push(hexRgb(n.stroke));
      if (inside.length > 0) next = snapBox(px, n, inside);
    } else {
      next = inkBox(px, before, bg, parentRect(n), n.type === "text" ? 48 : 30);
    }

    if (!next) continue;
    const band = bandFor(before);
    const moved =
      Math.abs(next.x - before.x) > band * 1.5 ||
      Math.abs(next.y - before.y) > band * 1.5 ||
      Math.abs(next.x + next.w - (before.x + before.w)) > band * 1.5 ||
      Math.abs(next.y + next.h - (before.y + before.h)) > band * 1.5;
    if (moved || iou(before, next) < 0.5) continue;
    n.x = next.x;
    n.y = next.y;
    n.w = next.w;
    n.h = next.h;
  }

  // Keep input order (z-order) for the caller.
  return { ...a, nodes: a.nodes.map((n) => byId.get(n.id)!) };
}
