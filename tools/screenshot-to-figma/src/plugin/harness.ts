// Test harness entry: exposes the renderer as `S2F` so it can be driven from
// a plain Plugin API script (used by the end-to-end visual tests).
import type { DesignTree } from "../shared/types";
import { Renderer, type RenderOptions } from "./render";

async function render(tree: DesignTree, images: Record<string, string>, options: RenderOptions) {
  const renderer = new Renderer(images, options);
  const frame = await renderer.render(tree);
  return { frame, stats: renderer.stats };
}

(globalThis as unknown as { S2F: unknown }).S2F = { render };
