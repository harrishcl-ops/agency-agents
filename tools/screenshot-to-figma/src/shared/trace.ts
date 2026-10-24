// Bitmap -> vector tracing for single-colour shapes (logos, icons, glyphs).
// Input is a coverage (alpha) matte; output is an SVG path that stays crisp at
// any zoom. Contours come from marching squares on a 4x-upsampled matte with
// sub-pixel edge interpolation, are simplified (Ramer-Douglas-Peucker), and
// smooth runs become cubic Béziers while sharp corners stay sharp.

import type { Pixels } from "./color";

type Pt = [number, number];

const UP = 4;

/** Alpha channel as 0..1 floats, upsampled bilinearly by UP, with a 1px empty border. */
function field(m: Pixels): { a: Float32Array; w: number; h: number } {
  const W = m.width * UP + 2;
  const H = m.height * UP + 2;
  const a = new Float32Array(W * H);
  const src = (x: number, y: number) => {
    const cx = Math.min(m.width - 1, Math.max(0, x));
    const cy = Math.min(m.height - 1, Math.max(0, y));
    return m.data[(cy * m.width + cx) * 4 + 3] / 255;
  };
  for (let y = 1; y < H - 1; y++) {
    const fy = (y - 1 + 0.5) / UP - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 1; x < W - 1; x++) {
      const fx = (x - 1 + 0.5) / UP - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      a[y * W + x] =
        src(x0, y0) * (1 - tx) * (1 - ty) + src(x0 + 1, y0) * tx * (1 - ty) + src(x0, y0 + 1) * (1 - tx) * ty + src(x0 + 1, y0 + 1) * tx * ty;
    }
  }
  return { a, w: W, h: H };
}

/** Closed iso-contours at level 0.5 (marching squares with saddle disambiguation). */
function contours(a: Float32Array, W: number, H: number): Pt[][] {
  const iso = 0.5;
  const v = (x: number, y: number) => a[y * W + x];
  const lerp = (p: number, q: number) => (iso - p) / (q - p);
  // Edge ids: horizontal edge (x,y)-(x+1,y) = 2*(y*W+x); vertical edge (x,y)-(x,y+1) = 2*(y*W+x)+1.
  const point = new Map<number, Pt>();
  const edgePt = (e: number): Pt => {
    let p = point.get(e);
    if (!p) {
      const cell = e >> 1;
      const x = cell % W;
      const y = (cell - x) / W;
      p = e & 1 ? [x, y + lerp(v(x, y), v(x, y + 1))] : [x + lerp(v(x, y), v(x + 1, y)), y];
      point.set(e, p);
    }
    return p;
  };
  const next = new Map<number, number>();
  const link = (from: number, to: number) => next.set(from, to);
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const tl = v(x, y) > iso ? 1 : 0;
      const tr = v(x + 1, y) > iso ? 1 : 0;
      const br = v(x + 1, y + 1) > iso ? 1 : 0;
      const bl = v(x, y + 1) > iso ? 1 : 0;
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (code === 0 || code === 15) continue;
      const top = 2 * (y * W + x);
      const bottom = 2 * ((y + 1) * W + x);
      const left = 2 * (y * W + x) + 1;
      const right = 2 * (y * W + x + 1) + 1;
      // Segments oriented with the inside on the left (consistent winding).
      const centre = (v(x, y) + v(x + 1, y) + v(x + 1, y + 1) + v(x, y + 1)) / 4 > iso;
      switch (code) {
        case 1: link(bottom, left); break;
        case 2: link(right, bottom); break;
        case 3: link(right, left); break;
        case 4: link(top, right); break;
        case 5: if (centre) { link(top, left); link(bottom, right); } else { link(top, right); link(bottom, left); } break;
        case 6: link(top, bottom); break;
        case 7: link(top, left); break;
        case 8: link(left, top); break;
        case 9: link(bottom, top); break;
        case 10: if (centre) { link(left, bottom); link(right, top); } else { link(left, top); link(right, bottom); } break;
        case 11: link(right, top); break;
        case 12: link(left, right); break;
        case 13: link(bottom, right); break;
        case 14: link(left, bottom); break;
      }
    }
  }
  const out: Pt[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: Pt[] = [];
    let e: number | undefined = start;
    while (e !== undefined && !seen.has(e)) {
      seen.add(e);
      loop.push(edgePt(e));
      e = next.get(e);
    }
    if (loop.length >= 3) out.push(loop);
  }
  return out;
}

function rdp(points: Pt[], eps: number): Pt[] {
  if (points.length < 3) return points;
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let worst = 0;
  let idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
    if (d > worst) {
      worst = d;
      idx = i;
    }
  }
  if (worst <= eps) return [points[0], points[points.length - 1]];
  return [...rdp(points.slice(0, idx + 1), eps).slice(0, -1), ...rdp(points.slice(idx), eps)];
}

/** Simplify a closed loop: split at the two farthest-apart points and run RDP on each half. */
function simplifyLoop(loop: Pt[], eps: number): Pt[] {
  let far = 0;
  let best = 0;
  for (let i = 1; i < loop.length; i++) {
    const d = Math.hypot(loop[i][0] - loop[0][0], loop[i][1] - loop[0][1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = rdp(loop.slice(0, far + 1), eps);
  const b = rdp([...loop.slice(far), loop[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/**
 * Snap near-horizontal / near-vertical segments exactly onto the axis (stems,
 * bars, rules and geometric logos are drawn that way); short segments and
 * diagonals are left alone.
 */
function regularize(loop: Pt[], minLen = 3, maxDeg = 4): Pt[] {
  const out = loop.map((p) => [p[0], p[1]] as Pt);
  const tan = Math.tan((maxDeg * Math.PI) / 180);
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    const b = out[(i + 1) % out.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    if (Math.hypot(dx, dy) < minLen) continue;
    if (Math.abs(dy) <= Math.abs(dx) * tan) {
      const y = (a[1] + b[1]) / 2;
      a[1] = y;
      b[1] = y;
    } else if (Math.abs(dx) <= Math.abs(dy) * tan) {
      const x = (a[0] + b[0]) / 2;
      a[0] = x;
      b[0] = x;
    }
  }
  return out;
}

const area = (loop: Pt[]) => loop.reduce((s, [x, y], i) => {
  const [nx, ny] = loop[(i + 1) % loop.length];
  return s + x * ny - nx * y;
}, 0) / 2;

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/** Path data for a loop: straight segments at corners, Catmull-Rom Béziers through smooth runs. */
function pathFor(loop: Pt[], cornerDeg: number): string {
  const n = loop.length;
  const corner = loop.map((p, i) => {
    const a = loop[(i - 1 + n) % n];
    const b = loop[(i + 1) % n];
    const v1 = [p[0] - a[0], p[1] - a[1]];
    const v2 = [b[0] - p[0], b[1] - p[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / ((Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1])) || 1);
    const short = Math.min(Math.hypot(v1[0], v1[1]), Math.hypot(v2[0], v2[1]));
    return Math.acos(Math.max(-1, Math.min(1, cos))) > (cornerDeg * Math.PI) / 180 || short > 6;
  });
  let d = `M${f(loop[0][0])} ${f(loop[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p1 = loop[i];
    const p2 = loop[(i + 1) % n];
    if (corner[i] && corner[(i + 1) % n]) {
      d += `L${f(p2[0])} ${f(p2[1])}`;
      continue;
    }
    const p0 = corner[i] ? p1 : loop[(i - 1 + n) % n];
    const p3 = corner[(i + 1) % n] ? p2 : loop[(i + 2) % n];
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + "Z";
}

export interface Traced {
  svg: string;
  /** Number of closed contours. */
  contours: number;
}

/**
 * Trace a coverage matte (alpha) into an SVG of the given colour, in the
 * matte's pixel space (viewBox = matte size). Returns null when there is
 * nothing to trace.
 */
export function traceMatte(m: Pixels, color: string, eps = 0.4, cornerDeg = 32): Traced | null {
  const { a, w, h } = field(m);
  const loops = contours(a, w, h)
    .map((loop) => loop.map(([x, y]) => [(x - 1 + 0.5) / UP, (y - 1 + 0.5) / UP] as Pt))
    .map((loop) => regularize(simplifyLoop(loop, eps)))
    .filter((loop) => loop.length >= 3 && Math.abs(area(loop)) > 0.3);
  if (loops.length === 0) return null;
  const d = loops.map((loop) => pathFor(loop, cornerDeg)).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${m.width}" height="${m.height}" viewBox="0 0 ${m.width} ${m.height}"><path fill="${color}" fill-rule="evenodd" d="${d}"/></svg>`;
  return { svg, contours: loops.length };
}
