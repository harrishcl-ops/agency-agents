import { describe, expect, it } from "vitest";
import type { Pixels } from "../src/shared/color";
import { traceMatte } from "../src/shared/trace";

function matte(w: number, h: number, inside: (x: number, y: number) => boolean): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[(y * w + x) * 4 + 3] = inside(x + 0.5, y + 0.5) ? 255 : 0;
  return { data, width: w, height: h };
}

describe("traceMatte", () => {
  it("traces a square as one straight-edged contour", () => {
    const t = traceMatte(matte(40, 40, (x, y) => x > 10 && x < 30 && y > 10 && y < 30), "#FFFFFF")!;
    expect(t.contours).toBe(1);
    expect(t.svg).toContain('fill="#FFFFFF"');
    expect(t.svg).not.toContain("C"); // straight sides only
  });

  it("keeps holes (rings, counters of letters) as separate contours", () => {
    const ring = traceMatte(matte(60, 60, (x, y) => {
      const r = Math.hypot(x - 30, y - 30);
      return r < 25 && r > 12;
    }), "#000000")!;
    expect(ring.contours).toBe(2);
    expect(ring.svg).toContain('fill-rule="evenodd"');
  });

  it("returns null for an empty matte", () => {
    expect(traceMatte(matte(10, 10, () => false), "#000000")).toBeNull();
  });
});
