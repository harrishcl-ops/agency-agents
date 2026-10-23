// Auto-layout inference. The model only hints at row/column; gap, padding and
// alignment are measured from the boxes, and a plan is accepted only if it
// reproduces every child's position within a small tolerance. Otherwise the
// frame keeps absolute positioning so the design still matches the screenshot.

import type { LayoutHint, Rect } from "./types";

export type Direction = "HORIZONTAL" | "VERTICAL";
export type PrimaryAlign = "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
export type CounterAlign = "MIN" | "CENTER" | "MAX";

export interface LayoutPlan {
  direction: Direction;
  gap: number;
  padding: { top: number; right: number; bottom: number; left: number };
  primary: PrimaryAlign;
  counter: CounterAlign;
  /** Per child (input order): true = positioned absolutely on top of the flow. */
  absolute: boolean[];
  /** Child indices in flow order. */
  order: number[];
  error: number;
}

interface Axis {
  start: (r: Rect) => number;
  size: (r: Rect) => number;
}
const X: Axis = { start: (r) => r.x, size: (r) => r.w };
const Y: Axis = { start: (r) => r.y, size: (r) => r.h };

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function overlap(a: Rect, b: Rect): boolean {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ix > 2 && iy > 2;
}

/** Later siblings that overlap an earlier flow sibling float on top (badges, overlays). */
export function findOverlays(children: Rect[]): boolean[] {
  const absolute = children.map(() => false);
  for (let i = 0; i < children.length; i++) {
    for (let j = 0; j < i; j++) {
      if (!absolute[j] && overlap(children[i], children[j])) {
        absolute[i] = true;
        break;
      }
    }
  }
  return absolute;
}

interface AxisFit {
  align: PrimaryAlign;
  padStart: number;
  padEnd: number;
  gap: number;
  error: number;
}

function fitMain(parentSize: number, starts: number[], sizes: number[]): AxisFit | null {
  const n = starts.length;
  const ends = starts.map((s, i) => s + sizes[i]);
  const gaps: number[] = [];
  for (let i = 1; i < n; i++) gaps.push(starts[i] - ends[i - 1]);
  if (gaps.some((g) => g < -1)) return null; // children overlap on this axis
  // Whole pixels when the screenshot allows it, else tenths (pixel accuracy wins).
  const exact = Math.max(0, median(gaps));
  const gap = Math.abs(exact - Math.round(exact)) < 0.15 ? Math.round(exact) : Math.round(exact * 10) / 10;
  const lead = Math.max(0, starts[0]);
  const trail = Math.max(0, parentSize - ends[n - 1]);
  const total = sizes.reduce((a, b) => a + b, 0);

  const err = (positions: number[]) =>
    Math.max(...positions.map((p, i) => Math.abs(p - starts[i])));
  const flow = (first: number, g: number) => {
    const out: number[] = [];
    let p = first;
    for (let i = 0; i < n; i++) {
      out.push(p);
      p += sizes[i] + g;
    }
    return out;
  };

  const symmetric = Math.min(lead, trail);
  const fits: AxisFit[] = [
    { align: "MIN", padStart: lead, padEnd: symmetric, gap, error: err(flow(lead, gap)) },
    {
      align: "CENTER",
      padStart: symmetric,
      padEnd: symmetric,
      gap,
      error: err(flow((parentSize - total - gap * (n - 1)) / 2, gap)),
    },
    {
      align: "MAX",
      padStart: symmetric,
      padEnd: trail,
      gap,
      error: err(flow(parentSize - trail - total - gap * (n - 1), gap)),
    },
  ];
  if (n >= 2) {
    const between = (parentSize - lead - trail - total) / (n - 1);
    if (between >= 0) {
      fits.push({ align: "SPACE_BETWEEN", padStart: lead, padEnd: trail, gap, error: err(flow(lead, between)) });
    }
  }
  // Prefer the simplest alignment unless another is clearly better.
  let best = fits[0];
  for (const f of fits) if (f.error < best.error - 0.5) best = f;
  return best;
}

interface CounterFit {
  align: CounterAlign;
  padStart: number;
  padEnd: number;
  error: number;
}

function fitCounter(parentSize: number, starts: number[], sizes: number[]): CounterFit {
  const before = starts;
  const after = starts.map((s, i) => parentSize - s - sizes[i]);
  const minBefore = Math.max(0, Math.min(...before));
  const minAfter = Math.max(0, Math.min(...after));
  const symmetric = Math.min(minBefore, minAfter);
  const fits: CounterFit[] = [
    {
      align: "MIN",
      padStart: minBefore,
      padEnd: minAfter,
      error: Math.max(...before.map((b) => Math.abs(b - minBefore))),
    },
    {
      align: "CENTER",
      padStart: symmetric,
      padEnd: symmetric,
      error: Math.max(...starts.map((s, i) => Math.abs(s - (parentSize - sizes[i]) / 2))),
    },
    {
      align: "MAX",
      padStart: minBefore,
      padEnd: minAfter,
      error: Math.max(...after.map((a) => Math.abs(a - minAfter))),
    },
  ];
  let best = fits[0];
  for (const f of fits) if (f.error < best.error - 0.5) best = f;
  return best;
}

/**
 * Find an auto-layout plan for `parent` that reproduces `children` positions.
 * All rects share one coordinate space. Returns null when no plan fits.
 */
export function planLayout(parent: Rect, children: Rect[], hint: LayoutHint, maxError?: number): LayoutPlan | null {
  if (children.length === 0) return null;
  const absolute = findOverlays(children);
  const flowIdx = children.map((_, i) => i).filter((i) => !absolute[i]);
  if (flowIdx.length === 0) return null;
  const tolerance = maxError ?? Math.max(3, 0.01 * Math.max(parent.w, parent.h));

  const directions: Direction[] = hint === "column" ? ["VERTICAL", "HORIZONTAL"] : ["HORIZONTAL", "VERTICAL"];
  let best: LayoutPlan | null = null;

  for (const direction of directions) {
    const main = direction === "HORIZONTAL" ? X : Y;
    const cross = direction === "HORIZONTAL" ? Y : X;
    const order = [...flowIdx].sort((a, b) => main.start(children[a]) - main.start(children[b]));
    const rel = (axis: Axis, i: number) => axis.start(children[i]) - axis.start(parent);

    const m = fitMain(
      main.size(parent),
      order.map((i) => rel(main, i)),
      order.map((i) => main.size(children[i])),
    );
    if (!m) continue;
    const c = fitCounter(
      cross.size(parent),
      order.map((i) => rel(cross, i)),
      order.map((i) => cross.size(children[i])),
    );
    const error = Math.max(m.error, c.error);
    if (error > tolerance) continue;

    const r = (v: number) => Math.max(0, Math.abs(v - Math.round(v)) < 0.15 ? Math.round(v) : Math.round(v * 10) / 10);
    const padding =
      direction === "HORIZONTAL"
        ? { left: r(m.padStart), right: r(m.padEnd), top: r(c.padStart), bottom: r(c.padEnd) }
        : { top: r(m.padStart), bottom: r(m.padEnd), left: r(c.padStart), right: r(c.padEnd) };
    const plan: LayoutPlan = {
      direction,
      gap: m.gap,
      padding,
      primary: m.align,
      counter: c.align,
      absolute,
      order,
      error,
    };
    if (!best || plan.error < best.error - 0.5) best = plan;
  }
  return best;
}
