import { describe, expect, it } from "vitest";
import type { Pixels } from "../src/shared/color";
import { inpaint, matte, overlayMask } from "../src/shared/inpaint";
import { fillRect } from "./helpers";

/** Vertical blue gradient, like a poster background. */
function gradient(w: number, h: number): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = 20 + (y * 60) / h;
      data[i + 1] = 60 + (y * 80) / h;
      data[i + 2] = 120 + (y * 100) / h;
      data[i + 3] = 255;
    }
  return { data, width: w, height: h };
}

describe("background cleanup", () => {
  it("erases white text from a gradient and mattes it back exactly", () => {
    const bg = gradient(200, 120);
    const poster: Pixels = { data: bg.data.slice(), width: 200, height: 120 };
    for (let x = 40; x < 160; x += 10) fillRect(poster, { x, y: 40, w: 5, h: 40 }, [255, 255, 255]);
    const text = { x: 38, y: 38, w: 124, h: 44 };

    const mask = overlayMask(poster, [{ kind: "ink", rect: text, ink: [255, 255, 255] }]);
    const clean = inpaint(poster, mask);
    let worst = 0;
    for (let i = 0; i < bg.data.length; i += 4) {
      worst = Math.max(worst, Math.abs(clean.data[i] - bg.data[i]), Math.abs(clean.data[i + 2] - bg.data[i + 2]));
    }
    expect(worst).toBeLessThan(12); // the strokes are gone, the gradient continues

    const m = matte(poster, clean, text, [255, 255, 255])!;
    const alphaAt = (x: number, y: number) => m.data[((y - text.y) * m.width + (x - text.x)) * 4 + 3];
    expect(alphaAt(42, 60)).toBe(255); // on a stroke
    expect(alphaAt(47, 60)).toBe(0); // between strokes
  });

  it("masks only the outline band of an outlined badge", () => {
    const px = gradient(100, 60);
    const mask = overlayMask(px, [{ kind: "outline", rect: { x: 20, y: 20, w: 60, h: 20 }, ink: null, strokeWidth: 1 }], 0);
    expect(mask[20 * 100 + 50]).toBe(1); // top edge
    expect(mask[30 * 100 + 50]).toBe(0); // inside
  });
});
