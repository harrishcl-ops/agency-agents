import { describe, expect, it } from "vitest";
import { dominantColor, normalizeHex, refineColors, textInkColor } from "../src/shared/color";
import { diffImages } from "../src/shared/diff";
import { inkBox, snapToPixels } from "../src/shared/snap";
import { detectPixelRatio, planSlices, splitInTwo } from "../src/shared/split";
import { buildTree } from "../src/shared/tree";
import { canvas, fillRect, node } from "./helpers";

describe("colour", () => {
  it("normalises hex", () => {
    expect(normalizeHex("abc")).toBe("#AABBCC");
    expect(normalizeHex("#11223344")).toBe("#11223344");
    expect(normalizeHex("#112233ff")).toBe("#112233");
    expect(normalizeHex("red")).toBeNull();
  });

  it("measures dominant and text ink colours", () => {
    const px = canvas(100, 40, [250, 250, 250]);
    fillRect(px, { x: 10, y: 10, w: 2, h: 20 }, [20, 40, 200]);
    fillRect(px, { x: 20, y: 10, w: 2, h: 20 }, [20, 40, 200]);
    expect(dominantColor(px, { x: 0, y: 0, w: 100, h: 40 })!.hex).toBe("#FAFAFA");
    expect(textInkColor(px, { x: 5, y: 5, w: 30, h: 30 })).toBe("#1428C8");
  });

  it("replaces estimated fills and text colours with measured ones", () => {
    const px = canvas(200, 100, [255, 255, 255]);
    fillRect(px, { x: 20, y: 20, w: 160, h: 60 }, [16, 185, 129]);
    for (let x = 42; x < 68; x += 4) fillRect(px, { x, y: 42, w: 2, h: 16 }, [255, 255, 255]); // glyph strokes
    const tree = buildTree(
      {
        screenName: "S",
        background: "#EEEEEE",
        nodes: [
          node({ id: "btn", x: 20, y: 20, w: 160, h: 60, fill: "#00AA77" }),
          node({ id: "label", parent: "btn", type: "text", x: 40, y: 40, w: 30, h: 20, text: { content: "Go", fontFamily: "Inter", fontWeight: 600, fontSize: 14, lineHeight: null, letterSpacing: null, color: "#F0F0F0", align: "left", italic: false, decoration: "none" } }),
        ],
      },
      200,
      100,
      1,
    );
    refineColors(tree, px);
    expect(tree.background).toBe("#FFFFFF");
    expect(tree.children[0].fill).toBe("#10B981");
    expect(tree.children[0].children[0].text!.color).toBe("#FFFFFF");
  });
});

describe("snapping", () => {
  it("snaps a filled card's edges to the pixels", () => {
    const px = canvas(300, 200);
    fillRect(px, { x: 40, y: 30, w: 200, h: 120 }, [30, 30, 30]);
    const snapped = snapToPixels(
      { screenName: "S", background: "#FFFFFF", nodes: [node({ id: "card", x: 37, y: 33, w: 205, h: 114, fill: "#1E1E1E" })] },
      px,
    );
    expect(snapped.nodes[0]).toMatchObject({ x: 40, y: 30, w: 200, h: 120 });
  });

  it("snaps text to its ink box and ignores neighbours", () => {
    const px = canvas(300, 100);
    fillRect(px, { x: 50, y: 40, w: 60, h: 12 }, [0, 0, 0]); // the text
    fillRect(px, { x: 150, y: 40, w: 40, h: 12 }, [0, 0, 0]); // a neighbour
    const box = inkBox(px, { x: 47, y: 38, w: 66, h: 16 }, [255, 255, 255], { x: 0, y: 0, w: 300, h: 100 });
    expect(box).toEqual({ x: 50, y: 40, w: 60, h: 12 });
  });

  it("keeps the model box when the measurement looks wrong", () => {
    const px = canvas(100, 100);
    const a = { screenName: "S", background: "#FFFFFF", nodes: [node({ id: "img", type: "image" as const, x: 10, y: 10, w: 30, h: 30 })] };
    expect(snapToPixels(a, px).nodes[0]).toMatchObject({ x: 10, y: 10, w: 30, h: 30 });
  });
});

describe("slicing and diff", () => {
  it("cuts tall pages at quiet rows", () => {
    const px = canvas(400, 2000);
    for (let y = 0; y < 2000; y += 100) fillRect(px, { x: 0, y: y + 20, w: 400, h: 60 }, [(y / 10) % 255, 100, 150]);
    const slices = planSlices(px);
    expect(slices.length).toBeGreaterThan(1);
    expect(slices.reduce((s, r) => s + r.h, 0)).toBe(2000);
    for (const s of slices.slice(1)) {
      const within = s.y % 100;
      expect(within < 20 || within >= 80).toBe(true);
    }
    const [a, b] = splitInTwo(px, { x: 0, y: 0, w: 400, h: 2000 });
    expect(a.h + b.h).toBe(2000);
  });

  it("detects retina and phone screenshots", () => {
    expect(detectPixelRatio(1170, 2532, "auto")).toBe(3);
    expect(detectPixelRatio(750, 1334, "auto")).toBe(2);
    expect(detectPixelRatio(2880, 1800, "auto")).toBe(2);
    expect(detectPixelRatio(1440, 9000, "auto")).toBe(1);
    expect(detectPixelRatio(1440, 900, "web")).toBe(1);
  });

  it("scores identical images as matching and flags real differences", () => {
    const a = canvas(50, 50);
    const b = canvas(50, 50);
    expect(diffImages(a, b).mismatch).toBe(0);
    fillRect(b, { x: 0, y: 0, w: 10, h: 10 }, [0, 0, 0]);
    expect(diffImages(a, b).mismatch).toBeCloseTo(0.04, 5);
    // A 1px shift is tolerated.
    const c = canvas(50, 50);
    const d = canvas(50, 50);
    fillRect(c, { x: 10, y: 10, w: 10, h: 10 }, [0, 0, 0]);
    fillRect(d, { x: 11, y: 10, w: 10, h: 10 }, [0, 0, 0]);
    expect(diffImages(c, d).mismatch).toBe(0);
  });
});
