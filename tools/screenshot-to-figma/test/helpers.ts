import type { Pixels } from "../src/shared/color";
import type { FlatNode, Rect } from "../src/shared/types";

export function canvas(w: number, h: number, bg: [number, number, number] = [255, 255, 255]): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg[0];
    data[i * 4 + 1] = bg[1];
    data[i * 4 + 2] = bg[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

export function fillRect(px: Pixels, r: Rect, color: [number, number, number]): void {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * px.width + x) * 4;
      px.data[i] = color[0];
      px.data[i + 1] = color[1];
      px.data[i + 2] = color[2];
      px.data[i + 3] = 255;
    }
  }
}

export function node(partial: Partial<FlatNode> & Pick<FlatNode, "id" | "x" | "y" | "w" | "h">): FlatNode {
  return {
    parent: "root",
    type: "frame",
    name: partial.id,
    fill: null,
    gradient: null,
    stroke: null,
    strokeWidth: null,
    radius: null,
    shadow: null,
    opacity: null,
    layout: "none",
    text: null,
    svg: null,
    ...partial,
  };
}
