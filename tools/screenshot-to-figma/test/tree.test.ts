import { describe, expect, it } from "vitest";
import { buildTree, mergeParts, sanitizeAnalysis, scaleNodes, subtreeIds } from "../src/shared/tree";
import { node } from "./helpers";

describe("sanitizeAnalysis", () => {
  it("repairs bad parents, cycles, duplicate ids and clips to the image", () => {
    const a = sanitizeAnalysis(
      {
        screenName: "Home",
        background: "fff",
        nodes: [
          { id: "a", parent: "b", type: "frame", x: -10, y: 0, w: 50, h: 50 },
          { id: "b", parent: "a", type: "frame", x: 0, y: 0, w: 20, h: 20 },
          { id: "a", parent: "root", type: "rectangle", x: 90, y: 90, w: 50, h: 50 },
          { id: "t", parent: "a_2", type: "text", x: 1, y: 1, w: 5, h: 5, text: null },
          { id: "c", parent: "missing", type: "bogus", x: 1, y: 1, w: 0, h: 5 },
          { id: "l", parent: "root", type: "line", x: 0, y: 10, w: 100, h: 0 },
        ],
      },
      100,
      100,
    );
    expect(a.background).toBe("#FFFFFF");
    const ids = a.nodes.map((n) => n.id);
    expect(ids).toEqual(["a", "b", "a_2", "l"]);
    // a <-> b cycle broken: at least one is at root.
    expect(a.nodes.some((n) => (n.id === "a" || n.id === "b") && n.parent === "root")).toBe(true);
    const first = a.nodes[0];
    expect(first.x).toBe(0);
    expect(first.w).toBe(40);
    const dup = a.nodes[2];
    expect(dup.w).toBe(10);
    expect(a.nodes[3].h).toBe(1);
  });

  it("drops text nodes without content and coerces text styles", () => {
    const a = sanitizeAnalysis(
      {
        nodes: [
          { id: "t1", parent: "root", type: "text", x: 0, y: 0, w: 10, h: 10, text: { content: "  " } },
          { id: "t2", parent: "root", type: "text", x: 0, y: 0, w: 10, h: 10, text: { content: "Hi", fontWeight: 650, color: "#abc", align: "middle" } },
        ],
      },
      50,
      50,
    );
    expect(a.nodes).toHaveLength(1);
    expect(a.nodes[0].text).toMatchObject({ content: "Hi", fontWeight: 700, color: "#AABBCC", align: "left", fontFamily: "Inter" });
  });
});

describe("tree helpers", () => {
  it("scales geometry and typography together", () => {
    const [n] = scaleNodes(
      [node({ id: "t", type: "text", x: 10, y: 20, w: 100, h: 30, text: { content: "x", fontFamily: "Inter", fontWeight: 400, fontSize: 32, lineHeight: 40, letterSpacing: null, color: "#000000", align: "left", italic: false, decoration: "none" } })],
      0.5,
      5,
      7,
    );
    expect(n).toMatchObject({ x: 10, y: 17, w: 50, h: 15 });
    expect(n.text!.fontSize).toBe(16);
    expect(n.text!.lineHeight).toBe(20);
  });

  it("merges slices with unique ids", () => {
    const merged = mergeParts([
      { screenName: "A", background: "#FFFFFF", nodes: [node({ id: "x", x: 0, y: 0, w: 1, h: 1 })] },
      { screenName: "B", background: "#000000", nodes: [node({ id: "x", x: 0, y: 5, w: 1, h: 1 }), node({ id: "y", parent: "x", x: 0, y: 5, w: 1, h: 1 })] },
    ]);
    expect(merged.nodes.map((n) => n.id)).toEqual(["p0_x", "p1_x", "p1_y"]);
    expect(merged.nodes[2].parent).toBe("p1_x");
  });

  it("builds a nested tree in design units with source rects", () => {
    const tree = buildTree(
      {
        screenName: "S",
        background: "#FFFFFF",
        nodes: [node({ id: "card", x: 20, y: 20, w: 200, h: 100 }), node({ id: "t", parent: "card", type: "rectangle", x: 40, y: 40, w: 20, h: 20 })],
      },
      400,
      300,
      2,
    );
    expect(tree.width).toBe(200);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]).toMatchObject({ x: 10, y: 10, w: 100, h: 50, src: { x: 20, y: 20, w: 200, h: 100 } });
    expect(tree.children[0].children[0].id).toBe("t");
  });

  it("collects subtrees", () => {
    const nodes = [node({ id: "a", x: 0, y: 0, w: 1, h: 1 }), node({ id: "b", parent: "a", x: 0, y: 0, w: 1, h: 1 }), node({ id: "c", parent: "b", x: 0, y: 0, w: 1, h: 1 }), node({ id: "d", x: 0, y: 0, w: 1, h: 1 })];
    expect([...subtreeIds(nodes, "a")].sort()).toEqual(["a", "b", "c"]);
  });
});
