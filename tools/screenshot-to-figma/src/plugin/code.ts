// Plugin main thread: owns the Figma document. The UI iframe does the image
// work and model calls and asks this side to render, export and finish.

import type { DesignTree } from "../shared/types";
import { Renderer, type RenderOptions, type RenderStats } from "./render";

const SETTINGS_KEY = "screen2figma.settings.v1";

type Inbound =
  | { type: "load-settings" }
  | { type: "save-settings"; settings: unknown }
  | { type: "use-selection" }
  | { type: "render"; id: number; tree: DesignTree; images: Record<string, Uint8Array>; options: RenderOptions; pixelRatio: number }
  | { type: "finish"; reference: Uint8Array | null; name: string }
  | { type: "notify"; message: string; error?: boolean }
  | { type: "resize"; height: number };

figma.showUI(__html__, { width: 380, height: 680, themeColors: true });

let current: FrameNode | null = null;
let placement: { x: number; y: number } | null = null;

function nextPlacement(width: number): { x: number; y: number } {
  const nodes = figma.currentPage.children.filter((n) => n !== current);
  if (nodes.length === 0) {
    const c = figma.viewport.center;
    return { x: Math.round(c.x - width / 2), y: Math.round(c.y) };
  }
  const right = Math.max(...nodes.map((n) => n.x + n.width));
  const top = Math.min(...nodes.map((n) => n.y));
  return { x: Math.round(right + 200), y: Math.round(top) };
}

async function render(msg: Extract<Inbound, { type: "render" }>): Promise<{ png: Uint8Array; stats: RenderStats }> {
  const renderer = new Renderer(msg.images, msg.options);
  const frame = await renderer.render(msg.tree);
  if (!placement) placement = nextPlacement(frame.width);
  frame.x = placement.x;
  frame.y = placement.y;
  if (current && !current.removed) current.remove();
  current = frame;
  const png = await frame.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: msg.pixelRatio } });
  return { png, stats: renderer.stats };
}

async function exportSelection(): Promise<void> {
  const node = figma.currentPage.selection[0];
  if (!node || !("exportAsync" in node)) {
    figma.ui.postMessage({ type: "selection-image", error: "Select an image or frame on the canvas first." });
    return;
  }
  // Prefer the original image bytes when the layer is a single image fill.
  if ("fills" in node && Array.isArray(node.fills)) {
    const image = (node.fills as Paint[]).find((p): p is ImagePaint => p.type === "IMAGE" && !!p.imageHash);
    if (image && image.imageHash) {
      const bytes = await figma.getImageByHash(image.imageHash)?.getBytesAsync();
      if (bytes) {
        figma.ui.postMessage({ type: "selection-image", bytes, name: node.name });
        return;
      }
    }
  }
  const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
  figma.ui.postMessage({ type: "selection-image", bytes, name: node.name });
}

function finish(reference: Uint8Array | null, name: string): void {
  if (!current) return;
  current.name = name;
  const result: SceneNode[] = [current];
  if (reference) {
    const ref = figma.createRectangle();
    ref.name = `${name} — original screenshot`;
    ref.resize(current.width, current.height);
    ref.fills = [{ type: "IMAGE", imageHash: figma.createImage(reference).hash, scaleMode: "FILL" }];
    ref.x = current.x + current.width + 80;
    ref.y = current.y;
    ref.locked = true;
    result.push(ref);
  }
  figma.currentPage.selection = [current];
  figma.viewport.scrollAndZoomIntoView(result);
  current = null;
  placement = null;
}

figma.ui.onmessage = async (msg: Inbound) => {
  try {
    switch (msg.type) {
      case "load-settings":
        figma.ui.postMessage({ type: "settings", settings: (await figma.clientStorage.getAsync(SETTINGS_KEY)) ?? null });
        break;
      case "save-settings":
        await figma.clientStorage.setAsync(SETTINGS_KEY, msg.settings);
        break;
      case "use-selection":
        await exportSelection();
        break;
      case "render": {
        const { png, stats } = await render(msg);
        figma.ui.postMessage({ type: "rendered", id: msg.id, png, stats });
        break;
      }
      case "finish":
        finish(msg.reference, msg.name);
        figma.ui.postMessage({ type: "finished" });
        break;
      case "notify":
        figma.notify(msg.message, { error: msg.error });
        break;
      case "resize":
        figma.ui.resize(380, Math.max(400, Math.min(900, Math.round(msg.height))));
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (msg.type === "render") figma.ui.postMessage({ type: "rendered", id: msg.id, error: message });
    else figma.ui.postMessage({ type: "error", message });
  }
};
