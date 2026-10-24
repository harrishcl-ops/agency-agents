import { describe, expect, it } from "vitest";
import { findOverlays, planLayout } from "../src/shared/layout";

describe("planLayout", () => {
  it("finds a horizontal row with padding, gap and centred children", () => {
    const parent = { x: 0, y: 0, w: 300, h: 60 };
    const children = [
      { x: 16, y: 18, w: 24, h: 24 },
      { x: 52, y: 20, w: 120, h: 20 },
    ];
    const plan = planLayout(parent, children, "row")!;
    expect(plan).not.toBeNull();
    expect(plan.direction).toBe("HORIZONTAL");
    expect(plan.gap).toBe(12);
    expect(plan.padding.left).toBe(16);
    expect(plan.primary).toBe("MIN");
    expect(plan.counter).toBe("CENTER");
  });

  it("finds a vertical stack even when the hint is wrong", () => {
    const parent = { x: 100, y: 100, w: 200, h: 200 };
    const children = [
      { x: 120, y: 120, w: 160, h: 30 },
      { x: 120, y: 166, w: 160, h: 30 },
      { x: 120, y: 212, w: 160, h: 30 },
    ];
    const plan = planLayout(parent, children, "row")!;
    expect(plan.direction).toBe("VERTICAL");
    expect(plan.gap).toBe(16);
    expect(plan.padding.top).toBe(20);
    expect(plan.counter).toBe("MIN");
  });

  it("uses space-between for a nav bar with items at both ends", () => {
    const parent = { x: 0, y: 0, w: 1000, h: 64 };
    const children = [
      { x: 24, y: 20, w: 100, h: 24 },
      { x: 876, y: 16, w: 100, h: 32 },
    ];
    const plan = planLayout(parent, children, "row")!;
    expect(plan.primary).toBe("SPACE_BETWEEN");
    expect(plan.padding.left).toBe(24);
    expect(plan.padding.right).toBe(24);
  });

  it("centres a button label", () => {
    const plan = planLayout({ x: 0, y: 0, w: 120, h: 40 }, [{ x: 30, y: 12, w: 60, h: 16 }], "none")!;
    expect(plan.primary).toBe("CENTER");
    expect(plan.counter).toBe("CENTER");
  });

  it("rejects uneven layouts that auto layout cannot reproduce", () => {
    const parent = { x: 0, y: 0, w: 400, h: 100 };
    const children = [
      { x: 0, y: 0, w: 50, h: 50 },
      { x: 60, y: 40, w: 50, h: 50 },
      { x: 300, y: 10, w: 50, h: 50 },
    ];
    expect(planLayout(parent, children, "row", 1.5)).toBeNull();
  });

  it("treats a full-bleed background with floating content as free layout", () => {
    const parent = { x: 0, y: 0, w: 1200, h: 1200 };
    const children = [
      { x: 0, y: 0, w: 1200, h: 1200 },
      { x: 240, y: 120, w: 140, h: 60 },
    ];
    expect(planLayout(parent, children, "column")).toBeNull();
  });

  it("keeps overlapping badges absolute", () => {
    const children = [
      { x: 0, y: 0, w: 24, h: 24 },
      { x: 16, y: -4, w: 12, h: 12 },
    ];
    expect(findOverlays(children)).toEqual([false, true]);
  });

  it("keeps fractional gaps when the screenshot needs them", () => {
    const parent = { x: 0, y: 0, w: 100, h: 200 };
    const children = [
      { x: 0, y: 0, w: 100, h: 20 },
      { x: 0, y: 30.5, w: 100, h: 20 },
      { x: 0, y: 61, w: 100, h: 20 },
    ];
    const plan = planLayout(parent, children, "column", 0.2)!;
    expect(plan.gap).toBe(10.5);
  });
});
