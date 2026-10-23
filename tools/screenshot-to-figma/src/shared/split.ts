// Cut tall images into slices at visually quiet rows (rows of near-uniform
// colour, i.e. gaps between sections) so no slice cuts through an element.

import type { Pixels } from "./color";
import type { Rect } from "./types";

/** Colour variance along one row (sampled), lower = more uniform. */
export function rowVariance(px: Pixels, y: number, x0 = 0, x1 = px.width): number {
  const samples = Math.min(256, x1 - x0);
  if (samples <= 0) return 0;
  const step = (x1 - x0) / samples;
  let sum = [0, 0, 0];
  let sq = [0, 0, 0];
  for (let k = 0; k < samples; k++) {
    const i = (y * px.width + Math.floor(x0 + k * step)) * 4;
    for (let c = 0; c < 3; c++) {
      const v = px.data[i + c];
      sum[c] += v;
      sq[c] += v * v;
    }
  }
  let variance = 0;
  for (let c = 0; c < 3; c++) {
    const mean = sum[c] / samples;
    variance += sq[c] / samples - mean * mean;
  }
  return variance;
}

/** Best cut row in [lo, hi): most uniform, ties broken towards `target`. */
export function quietRow(px: Pixels, region: Rect, lo: number, hi: number, target: number): number {
  let best = target;
  let bestScore = Infinity;
  for (let y = Math.max(region.y + 1, Math.floor(lo)); y < Math.min(region.y + region.h - 1, Math.ceil(hi)); y++) {
    const score = rowVariance(px, y, region.x, region.x + region.w) + Math.abs(y - target) * 0.01;
    if (score < bestScore) {
      bestScore = score;
      best = y;
    }
  }
  return best;
}

/** Split `region` horizontally into two at a quiet row near its middle. */
export function splitInTwo(px: Pixels, region: Rect): [Rect, Rect] {
  const mid = region.y + region.h / 2;
  const y = quietRow(px, region, mid - region.h * 0.2, mid + region.h * 0.2, mid);
  return [
    { x: region.x, y: region.y, w: region.w, h: y - region.y },
    { x: region.x, y, w: region.w, h: region.y + region.h - y },
  ];
}

/**
 * Slices for a full screenshot. Images taller than `maxAspect` x width are cut
 * into chunks around `targetAspect` x width.
 */
export function planSlices(px: Pixels, maxAspect = 2.2, targetAspect = 1.5): Rect[] {
  const full: Rect = { x: 0, y: 0, w: px.width, h: px.height };
  if (px.height <= px.width * maxAspect) return [full];
  const target = Math.round(px.width * targetAspect);
  const slices: Rect[] = [];
  let top = 0;
  while (px.height - top > target * 1.3) {
    const ideal = top + target;
    const cut = quietRow(px, full, ideal - target * 0.25, ideal + target * 0.2, ideal);
    slices.push({ x: 0, y: top, w: px.width, h: cut - top });
    top = cut;
  }
  slices.push({ x: 0, y: top, w: px.width, h: px.height - top });
  return slices;
}

/** Guess the device pixel ratio of a screenshot from its size and platform. */
export function detectPixelRatio(width: number, height: number, platform: string): number {
  // Common phone screenshot widths (portrait, including full-page captures).
  const PHONE_3X = [1080, 1125, 1170, 1179, 1206, 1242, 1284, 1290, 1320];
  const PHONE_2X = [640, 720, 750, 828];
  const portrait = height > width * 1.3;
  const near = (list: number[]) => list.some((w) => Math.abs(width - w) <= 2);

  if (platform === "mobile") {
    if (width >= 1000) return 3;
    if (width >= 600) return 2;
    return 1;
  }
  if (platform === "auto" && portrait && near(PHONE_3X)) return 3;
  if (platform === "auto" && portrait && near(PHONE_2X)) return 2;
  if (platform === "tablet") return width >= 1500 ? 2 : 1;
  return width >= 2400 ? 2 : 1;
}
