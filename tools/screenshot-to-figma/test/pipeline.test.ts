import { describe, expect, it } from "vitest";
import type { AnalyzeRequest, Correction } from "../src/shared/analyze";
import { hexToRgba, type Pixels } from "../src/shared/color";
import { Pipeline, modelScale, type Host } from "../src/shared/pipeline";
import type { Analysis, DesignNode, DesignTree, ModelImage, Rect } from "../src/shared/types";
import { canvas, fillRect, node } from "./helpers";

/** Paint frames/rectangles of a design tree (design units * ratio = source px). */
function rasterize(tree: DesignTree, w: number, h: number, ratio: number): Pixels {
  const bg = hexToRgba(tree.background);
  const px = canvas(w, h, [bg.r * 255, bg.g * 255, bg.b * 255]);
  const paint = (n: DesignNode) => {
    if (n.fill) {
      const c = hexToRgba(n.fill);
      const r = {
        x: Math.round(n.x * ratio),
        y: Math.round(n.y * ratio),
        w: Math.round(n.w * ratio),
        h: Math.round(n.h * ratio),
      };
      fillRect(px, r, [c.r * 255, c.g * 255, c.b * 255]);
    }
    n.children.forEach(paint);
  };
  tree.children.forEach(paint);
  return px;
}

function fakeImage(region: Rect, scale: number): ModelImage {
  return { base64: "", mediaType: "image/png", width: Math.round(region.w * scale), height: Math.round(region.h * scale) };
}

describe("Pipeline", () => {
  // Original: white page, dark header, blue card, and a red badge.
  const W = 800;
  const H = 600;
  const original = canvas(W, H);
  fillRect(original, { x: 0, y: 0, w: 800, h: 80 }, [17, 24, 39]);
  fillRect(original, { x: 100, y: 200, w: 300, h: 200 }, [37, 99, 235]);
  fillRect(original, { x: 500, y: 250, w: 60, h: 60 }, [220, 38, 38]);

  function makeHost(analysis: (req: AnalyzeRequest) => Analysis, correction: () => Correction) {
    const renders: DesignTree[] = [];
    let corrections = 0;
    const host: Host = {
      pixels: original,
      encode: async (_px, region, scale) => fakeImage(region, scale),
      crop: async () => new Uint8Array([1]),
      analyze: async (req) => analysis(req),
      correct: async () => {
        corrections++;
        return correction();
      },
      render: async (tree) => {
        renders.push(tree);
        return rasterize(tree, W, H, 1);
      },
      status: () => undefined,
      cancelled: () => false,
    };
    return { host, renders, corrections: () => corrections };
  }

  // The "model" sees the image at modelScale and reports slightly-off boxes, misses the badge.
  const scale = modelScale({ x: 0, y: 0, w: W, h: H }, 2576);
  const modelAnalysis = (): Analysis => ({
    screenName: "Test",
    background: "#FFFFFF",
    nodes: [
      node({ id: "header", x: 0, y: 0, w: 800 * scale, h: 77 * scale, fill: "#111827", layout: "row" }),
      node({ id: "card", x: 103 * scale, y: 197 * scale, w: 296 * scale, h: 205 * scale, fill: "#2563EB" }),
    ],
  });

  it("snaps model boxes to pixels and adds missing elements via corrections", async () => {
    const { host, renders, corrections } = makeHost(modelAnalysis, () => ({
      updates: [],
      additions: [{ id: "badge", parent: "root", type: "rectangle", name: "Badge", x: 498 * scale, y: 252 * scale, w: 64 * scale, h: 58 * scale, fill: "#DC2626", gradient: null, stroke: null, strokeWidth: null, radius: null, shadow: null, opacity: null, layout: "none", text: null, svg: null }],
      deletions: [],
    }));
    const pipeline = new Pipeline(host, {
      platform: "web",
      pixelRatio: 1,
      autoLayout: true,
      iconMode: "image",
      addReference: false,
      quality: "pixel-perfect",
      maxRounds: 3,
      maxEdge: 2576,
      concurrency: 2,
    });
    const result = await pipeline.run();

    const card = result.analysis.nodes.find((n) => n.id === "card")!;
    expect(card).toMatchObject({ x: 100, y: 200, w: 300, h: 200 });
    const header = result.analysis.nodes.find((n) => n.id === "header")!;
    expect(header.h).toBe(80);
    const badge = result.analysis.nodes.find((n) => n.name === "Badge")!;
    expect(badge).toMatchObject({ x: 500, y: 250, w: 60, h: 60 });

    expect(corrections()).toBeGreaterThan(0);
    expect(result.mismatchHistory[0]).toBeGreaterThan(0);
    expect(result.mismatchHistory.at(-1)).toBe(0);
    expect(renders.length).toBeGreaterThanOrEqual(2);
  });

  it("fast mode renders once without corrections", async () => {
    const { host, renders, corrections } = makeHost(modelAnalysis, () => ({ updates: [], additions: [], deletions: [] }));
    const pipeline = new Pipeline(host, {
      platform: "web",
      pixelRatio: 0,
      autoLayout: true,
      iconMode: "image",
      addReference: false,
      quality: "fast",
      maxRounds: 0,
      maxEdge: 2576,
      concurrency: 2,
    });
    const result = await pipeline.run();
    expect(renders).toHaveLength(1);
    expect(corrections()).toBe(0);
    expect(result.pixelRatio).toBe(1);
  });

  it("splits a region in two when the model runs out of tokens", async () => {
    const { AnalysisError } = await import("../src/shared/analyze");
    let calls = 0;
    const { host } = makeHost(
      (req) => {
        calls++;
        if (!req.part) throw new AnalysisError("too many", "too_many_elements");
        return { screenName: "Part", background: "#FFFFFF", nodes: [node({ id: "x", x: 0, y: 0, w: 10, h: 10, fill: "#000000" })] };
      },
      () => ({ updates: [], additions: [], deletions: [] }),
    );
    const pipeline = new Pipeline(host, {
      platform: "web",
      pixelRatio: 1,
      autoLayout: false,
      iconMode: "image",
      addReference: false,
      quality: "fast",
      maxRounds: 0,
      maxEdge: 2576,
      concurrency: 1,
    });
    const result = await pipeline.run();
    expect(calls).toBe(3);
    expect(result.analysis.nodes).toHaveLength(2);
    expect(result.analysis.nodes[1].y).toBeGreaterThan(0);
  });
});
