// Pixel snapping: replace model-estimated boxes with boxes measured from the
// screenshot. Containers snap their edges to where their fill (or border)
// ends; text, images and icons snap to the tight bounding box of their "ink"
// (pixels that differ from the background behind them). Text boxes become
// glyph bounds, which the renderer aligns using Figma's render bounds.

import { hexToRgba, surroundingColor, type Pixels } from "./color";
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

/**
 * How far an edge may be searched from its estimate: grows with the box (model
 * errors scale with size) but never more than ~30% of the short side, so a
 * search cannot cross the element.
 */
function bandFor(r: Rect): number {
  const grow = Math.round(0.04 * Math.max(r.w, r.h) + 2);
  return Math.max(2, Math.min(32, grow, Math.round(0.3 * Math.min(r.w, r.h))));
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
    const limit = horizontal ? px.width : px.height;
    for (let d = -band; d <= band; d++) {
      const p = Math.round(edge + outward * d);
      const q = p - (outward > 0 ? 1 : 0); // pixel just inside boundary p
      if (q < 0 || q >= limit) break; // the image border is the edge
      const c = horizontal ? at(px, q, t) : at(px, t, q);
      if (isInside(c)) last = p;
      else if (last !== null) break;
    }
    if (last !== null) found.push(last);
  }
  if (found.length < Math.ceil(lines * 0.6)) return null;
  return median(found);
}

function snapBox(px: Pixels, node: FlatNode, inside: RGB[], contrast: number): Rect {
  const r: Rect = { x: node.x, y: node.y, w: node.w, h: node.h };
  const band = bandFor(r);
  const pill = (node.radius ?? 0) > Math.min(r.w, r.h) * 0.25 || node.type === "ellipse";
  const spread = pill ? 0.08 : 0.25;
  // Tolerance adapts to contrast: subtle dark-mode cards still have clean edges.
  const tol = Math.max(4, Math.min(22, contrast / 2));
  const isInside = (c: RGB) => inside.some((ref) => dist(c, ref) < tol);

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

/** Runs overlapping [lo, hi) by at least half their own length. */
function mostlyInside(rs: [number, number][], lo: number, hi: number): [number, number][] {
  return rs.filter(([s, e]) => Math.min(e, hi) - Math.max(s, lo) >= (e - s) / 2);
}

/**
 * Start from runs mostly inside [lo, hi) and absorb neighbours closer than
 * `maxGap` (recovers words/edges a too-small estimate clipped off).
 */
function grow(rs: [number, number][], lo: number, hi: number, maxGap: number): [number, number] | null {
  const seed = mostlyInside(rs, lo, hi);
  if (seed.length === 0) return null;
  let a = Math.min(...seed.map((r) => r[0]));
  let b = Math.max(...seed.map((r) => r[1]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [s, e] of rs) {
      if (s >= b && s - b <= maxGap) {
        b = e;
        changed = true;
      } else if (e <= a && a - e <= maxGap) {
        a = s;
        changed = true;
      }
    }
  }
  return [a, b];
}

export interface Ink {
  box: Rect;
  /** Text only: number of ink lines and their pitch (null for one line). */
  lines: number;
  pitch: number | null;
}

/**
 * Tight bounding box of pixels differing from the background near `r`.
 * Rows (lines) must lie mostly inside the estimate, so a neighbouring label
 * just above or below is not swallowed; columns are measured within those
 * rows and may grow across word gaps.
 */
export function inkBox(px: Pixels, r: Rect, bg: RGB, clip: Rect, threshold = 40, isText = false): Ink | null {
  const band = bandFor(r);
  const x0 = Math.max(0, Math.floor(Math.max(clip.x, r.x - band)));
  const x1 = Math.min(px.width, Math.ceil(Math.min(clip.x + clip.w, r.x + r.w + band)));
  if (x1 - x0 < 1) return null;

  // Local background: the dominant colour around the box.
  const around = surroundingColor(px, r);
  const ref = around && around.share > 0.5 ? around.rgb : bg;
  const isInk = (x: number, y: number) => {
    const i = (y * px.width + x) * 4;
    return dist([px.data[i], px.data[i + 1], px.data[i + 2]], ref) > threshold;
  };

  // Rows first, measured across the estimate's columns only. Scan well past
  // the estimate so neighbouring runs are seen whole before judging overlap.
  const ry0 = Math.max(0, Math.floor(Math.max(clip.y, r.y - r.h - band)));
  const ry1 = Math.min(px.height, Math.ceil(Math.min(clip.y + clip.h, r.y + 2 * r.h + band)));
  const rows = new Array(ry1 - ry0).fill(0);
  const cx0 = Math.max(x0, Math.floor(r.x));
  const cx1 = Math.min(x1, Math.ceil(r.x + r.w));
  for (let y = ry0; y < ry1; y++) for (let x = cx0; x < cx1; x++) if (isInk(x, y)) rows[y - ry0]++;
  const lineRuns = mostlyInside(runs(rows), r.y - ry0, r.y + r.h - ry0);
  if (lineRuns.length === 0) return null;
  const ya = ry0 + Math.min(...lineRuns.map((l) => l[0]));
  const yb = ry0 + Math.max(...lineRuns.map((l) => l[1]));

  // Columns within those rows.
  const cols = new Array(x1 - x0).fill(0);
  for (let y = ya; y < yb; y++) for (let x = x0; x < x1; x++) if (isInk(x, y)) cols[x - x0]++;
  // Word spaces are ~0.3em, about half the glyph height of a line; anything
  // further away is a neighbouring element (icon, thumbnail, next label).
  const inkLine = Math.min(...lineRuns.map((l) => l[1] - l[0]));
  const xs = grow(runs(cols), r.x - x0, r.x + r.w - x0, isText ? Math.max(2, inkLine * 0.5) : 1);
  if (!xs) return null;

  let pitch: number | null = null;
  if (isText && lineRuns.length >= 2) {
    const tops = lineRuns.map((l) => l[0]).sort((a, b) => a - b);
    const diffs = tops.slice(1).map((t, i) => t - tops[i]).sort((a, b) => a - b);
    pitch = diffs[Math.floor(diffs.length / 2)];
  }
  return {
    box: { x: x0 + xs[0], y: ya, w: xs[1] - xs[0], h: yb - ya },
    lines: lineRuns.length,
    pitch,
  };
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
  const snapped = new Set<string>();
  // Search area for a child: its parent's box when that box was measured,
  // otherwise the parent's estimate widened by its own search band.
  const parentRect = (n: FlatNode): Rect => {
    const p = byId.get(n.parent);
    if (!p) return full;
    const pad = snapped.has(p.id) ? 0 : bandFor(p) * 1.5;
    return { x: p.x - pad, y: p.y - pad, w: p.w + 2 * pad, h: p.h + 2 * pad };
  };

  for (const n of parentsFirst(nodes)) {
    const before: Rect = { x: n.x, y: n.y, w: n.w, h: n.h };
    const bg = backgroundOf(n);
    let next: Rect | null = null;

    if (n.type === "frame" || n.type === "rectangle" || n.type === "ellipse" || n.type === "line") {
      // Use the measured colours just inside the box, not the model's estimate.
      const inside: RGB[] = [];
      const candidates = [isOpaqueHex(n.fill) && !n.gradient ? hexRgb(n.fill) : null, isOpaqueHex(n.stroke) ? hexRgb(n.stroke) : null];
      for (const c of candidates) if (c && dist(c, bg) > 8) inside.push(c);
      if (inside.length > 0) {
        const contrast = Math.min(...inside.map((c) => dist(c, bg)));
        next = snapBox(px, n, inside, contrast);
      }
    } else {
      const ink = inkBox(px, before, bg, parentRect(n), n.type === "text" ? 48 : 30, n.type === "text");
      next = ink ? ink.box : null;
      if (ink && n.text && iou(before, ink.box) >= 0.5) {
        n.text = { ...n.text, lines: ink.lines };
        if (ink.pitch && ink.lines >= 2) n.text.lineHeight = ink.pitch;
      }
    }

    if (!next) continue;
    // Reject measurements that moved implausibly far: each edge may move by
    // the search band, or for text/images up to a share of the element's size
    // on that axis (estimates are proportionally off for big elements).
    const band = bandFor(before);
    const ink = n.type === "text" || n.type === "image" || n.type === "icon";
    const limX = Math.max(band * 1.5, ink ? before.w * 0.25 : 0);
    const limY = Math.max(band * 1.5, ink ? before.h * 0.45 : 0);
    const moved =
      Math.abs(next.x - before.x) > limX ||
      Math.abs(next.x + next.w - (before.x + before.w)) > limX ||
      Math.abs(next.y - before.y) > limY ||
      Math.abs(next.y + next.h - (before.y + before.h)) > limY;
    if (moved || iou(before, next) < 0.4) continue;
    n.x = next.x;
    n.y = next.y;
    n.w = next.w;
    n.h = next.h;
    snapped.add(n.id);
  }

  // Frames that could not be measured (transparent groups, white-on-white
  // cards) grow to contain their measured children, deepest first.
  for (const n of parentsFirst(nodes).reverse()) {
    if (n.type !== "frame" || snapped.has(n.id)) continue;
    const kids = nodes.filter((c) => c.parent === n.id);
    if (kids.length === 0) continue;
    const x1 = Math.min(n.x, ...kids.map((c) => c.x));
    const y1 = Math.min(n.y, ...kids.map((c) => c.y));
    const x2 = Math.max(n.x + n.w, ...kids.map((c) => c.x + c.w));
    const y2 = Math.max(n.y + n.h, ...kids.map((c) => c.y + c.h));
    const limit = bandFor(n) * 1.5;
    if (n.x - x1 > limit || y1 < n.y - limit || x2 - (n.x + n.w) > limit || y2 - (n.y + n.h) > limit) continue;
    n.x = x1;
    n.y = y1;
    n.w = x2 - x1;
    n.h = y2 - y1;
  }

  // Keep input order (z-order) for the caller.
  return { ...a, nodes: a.nodes.map((n) => byId.get(n.id)!) };
}
