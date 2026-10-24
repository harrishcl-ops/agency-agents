// Turns a DesignTree into Figma layers. Runs in the plugin main thread.
//
// Layers are built bottom-up: every child is created and measured first, then
// its parent decides between auto layout (when a plan reproduces the measured
// positions) and absolute positioning. Text boxes are derived from Figma's
// actual glyph render bounds so the glyphs land on the screenshot's ink box.

import { hexToRgba } from "../shared/color";
import { planLayout, type LayoutPlan } from "../shared/layout";
import type { DesignNode, DesignTree, Gradient, IconMode, Rect, Shadow, TextStyle } from "../shared/types";
import { FontResolver } from "./fonts";

export interface RenderOptions {
  autoLayout: boolean;
  iconMode: IconMode;
  /** Max position error (design px) an auto-layout plan may introduce. */
  layoutTolerance: number;
  /** Scale single-line text so its glyph width matches the screenshot. */
  fitText: boolean;
}

export interface RenderStats {
  layers: number;
  texts: number;
  images: number;
  autoLayoutFrames: number;
  failed: number;
  substitutedFonts: string[];
}

interface Built {
  layer: SceneNode;
  /** Box the layer must occupy, in tree (design) coordinates. */
  rect: Rect;
}

function solid(hex: string): SolidPaint {
  const { r, g, b, a } = hexToRgba(hex);
  return { type: "SOLID", color: { r, g, b }, opacity: a };
}

/** CSS linear-gradient angle (0 = to top, 90 = to right) to a Figma gradient paint. */
export function gradientPaint(gradient: Gradient): GradientPaint {
  const rad = ((gradient.angle - 90) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    type: "GRADIENT_LINEAR",
    gradientTransform: [
      [cos, sin, 0.5 - cos * 0.5 - sin * 0.5],
      [-sin, cos, 0.5 + sin * 0.5 - cos * 0.5],
    ],
    gradientStops: gradient.stops.map((s) => {
      const { r, g, b, a } = hexToRgba(s.color);
      return { position: s.position, color: { r, g, b, a } };
    }),
  };
}

function shadowEffect(shadow: Shadow): DropShadowEffect {
  const { r, g, b, a } = hexToRgba(shadow.color);
  return {
    type: "DROP_SHADOW",
    color: { r, g, b, a: a === 1 ? 0.25 : a },
    offset: { x: shadow.x, y: shadow.y },
    radius: shadow.blur,
    spread: shadow.spread,
    visible: true,
    blendMode: "NORMAL",
  };
}

type Styled = FrameNode | RectangleNode | EllipseNode;

function applyBox(target: Styled, node: DesignNode): void {
  const fills: Paint[] = [];
  if (node.gradient) fills.push(gradientPaint(node.gradient));
  else if (node.fill) fills.push(solid(node.fill));
  target.fills = fills;
  if (node.stroke) {
    target.strokes = [solid(node.stroke)];
    target.strokeWeight = Math.max(0.5, node.strokeWidth ?? 1);
    target.strokeAlign = "INSIDE";
  }
  if (node.radius && target.type !== "ELLIPSE") {
    target.cornerRadius = Math.min(node.radius, node.w / 2, node.h / 2);
  }
  if (node.shadow) target.effects = [shadowEffect(node.shadow)];
  if (node.opacity !== null && node.opacity >= 0 && node.opacity < 1) target.opacity = node.opacity;
}

const isCircle = (node: DesignNode) =>
  node.radius !== null && node.radius >= Math.min(node.w, node.h) / 2 - 0.5 && Math.abs(node.w - node.h) <= 2;

export function isSingleLine(text: TextStyle, h: number): boolean {
  if (text.content.includes("\n")) return false;
  const line = text.lineHeight ?? text.fontSize * 1.3;
  return h < line * 1.5;
}

const rectOf = (n: DesignNode): Rect => ({ x: n.x, y: n.y, w: n.w, h: n.h });

/** Glyph bounds of a text layer relative to its own top-left, or null. */
function inkOffset(t: TextNode): Rect | null {
  const rb = t.absoluteRenderBounds;
  const tx = t.absoluteTransform[0][2];
  const ty = t.absoluteTransform[1][2];
  if (!rb || rb.width <= 0 || rb.height <= 0) return null;
  return { x: rb.x - tx, y: rb.y - ty, w: rb.width, h: rb.height };
}

export class Renderer {
  readonly stats: RenderStats = {
    layers: 0,
    texts: 0,
    images: 0,
    autoLayoutFrames: 0,
    failed: 0,
    substitutedFonts: [],
  };
  private fonts!: FontResolver;

  /** Image bytes per node id, or an existing Figma image hash. */
  constructor(
    private images: Record<string, Uint8Array | string>,
    private options: RenderOptions,
  ) {}

  async render(tree: DesignTree): Promise<FrameNode> {
    this.fonts = new FontResolver((await figma.listAvailableFontsAsync()).map((f) => f.fontName));
    await this.preloadFonts(tree.children);

    const root = figma.createFrame();
    root.name = tree.name;
    root.resize(Math.max(1, tree.width), Math.max(1, tree.height));
    root.fills = [solid(tree.background)];
    root.clipsContent = true;

    const children = await this.buildAll(tree.children);
    this.arrange(root, { x: 0, y: 0, w: tree.width, h: tree.height }, children, "column");

    this.stats.substitutedFonts = [...this.fonts.substituted];
    return root;
  }

  private async preloadFonts(nodes: DesignNode[]): Promise<void> {
    const load = (f: FontName) => figma.loadFontAsync(f);
    const jobs: Promise<void>[] = [this.fonts.load({ family: "Inter", style: "Regular" }, load)];
    const walk = (list: DesignNode[]) => {
      for (const n of list) {
        if (n.text) jobs.push(this.fonts.load(this.fonts.resolve(n.text.fontFamily, n.text.fontWeight, n.text.italic), load));
        walk(n.children);
      }
    };
    walk(nodes);
    await Promise.all(jobs.map((j) => j.catch(() => undefined)));
  }

  private async buildAll(nodes: DesignNode[]): Promise<Built[]> {
    const out: Built[] = [];
    for (const n of nodes) {
      try {
        out.push(await this.build(n));
        this.stats.layers++;
      } catch (err) {
        console.warn(`Screen2Figma: could not create "${n.name}"`, err);
        this.stats.failed++;
      }
    }
    return out;
  }

  /** Put measured children into `parent`, with auto layout when a plan fits. */
  private arrange(parent: FrameNode, parentRect: Rect, children: Built[], hint: DesignNode["layout"]): void {
    if (children.length === 0) return;
    const plan = this.options.autoLayout
      ? planLayout(parentRect, children.map((c) => c.rect), hint, this.options.layoutTolerance)
      : null;

    const placeAbsolute = (c: Built) => {
      c.layer.x = c.rect.x - parentRect.x;
      c.layer.y = c.rect.y - parentRect.y;
    };

    if (!plan) {
      for (const c of children) {
        parent.appendChild(c.layer);
        placeAbsolute(c);
      }
      return;
    }
    this.applyPlan(parent, plan);
    for (const i of plan.order) parent.appendChild(children[i].layer);
    children.forEach((c, i) => {
      if (!plan.absolute[i]) return;
      parent.appendChild(c.layer);
      (c.layer as FrameNode).layoutPositioning = "ABSOLUTE";
      placeAbsolute(c);
    });
  }

  private applyPlan(frame: FrameNode, plan: LayoutPlan): void {
    const { width, height } = frame;
    frame.layoutMode = plan.direction;
    frame.primaryAxisSizingMode = "FIXED";
    frame.counterAxisSizingMode = "FIXED";
    frame.resize(width, height);
    frame.itemSpacing = plan.gap;
    frame.paddingTop = plan.padding.top;
    frame.paddingRight = plan.padding.right;
    frame.paddingBottom = plan.padding.bottom;
    frame.paddingLeft = plan.padding.left;
    frame.primaryAxisAlignItems = plan.primary;
    frame.counterAxisAlignItems = plan.counter;
    this.stats.autoLayoutFrames++;
  }

  private async build(node: DesignNode): Promise<Built> {
    switch (node.type) {
      case "text":
        return this.buildText(node);
      case "image":
      case "icon":
        return { layer: await this.buildImage(node), rect: rectOf(node) };
      case "ellipse": {
        const e = figma.createEllipse();
        e.name = node.name;
        e.resize(Math.max(0.01, node.w), Math.max(0.01, node.h));
        applyBox(e, node);
        return { layer: e, rect: rectOf(node) };
      }
      case "rectangle":
      case "line": {
        const r = figma.createRectangle();
        r.name = node.name;
        r.resize(Math.max(0.01, node.w), Math.max(0.01, node.h));
        applyBox(r, node);
        if (!node.fill && !node.gradient && node.stroke) {
          // Dividers described only by a stroke colour: draw them filled.
          r.fills = [solid(node.stroke)];
          r.strokes = [];
        }
        return { layer: r, rect: rectOf(node) };
      }
      case "frame":
      default: {
        const frame = figma.createFrame();
        frame.name = node.name;
        frame.resize(Math.max(0.01, node.w), Math.max(0.01, node.h));
        applyBox(frame, node);
        frame.clipsContent = (node.radius ?? 0) > 0 && node.children.some((c) => c.type === "image");
        const children = await this.buildAll(node.children);
        this.arrange(frame, rectOf(node), children, node.layout);
        return { layer: frame, rect: rectOf(node) };
      }
    }
  }

  /**
   * Create a text layer whose glyphs cover `node`'s box (the measured ink box
   * of the text in the screenshot) and return the layer box that achieves it.
   */
  private async buildText(node: DesignNode): Promise<Built> {
    const style = node.text!;
    const t = figma.createText();
    const font = this.fonts.resolve(style.fontFamily, style.fontWeight, style.italic);
    try {
      await this.fonts.load(font, (f) => figma.loadFontAsync(f));
      t.fontName = font;
    } catch {
      t.fontName = { family: "Inter", style: "Regular" };
    }
    t.name = node.name;
    t.characters = style.content;
    t.fontSize = Math.max(1, style.fontSize);
    if (style.lineHeight && style.lineHeight > style.fontSize * 0.8) {
      t.lineHeight = { unit: "PIXELS", value: style.lineHeight };
    }
    if (style.letterSpacing) t.letterSpacing = { unit: "PIXELS", value: style.letterSpacing };
    t.fills = [solid(style.color)];
    t.textAlignHorizontal =
      style.align === "center" ? "CENTER" : style.align === "right" ? "RIGHT" : style.align === "justify" ? "JUSTIFIED" : "LEFT";
    if (style.decoration === "underline") t.textDecoration = "UNDERLINE";
    if (style.decoration === "strikethrough") t.textDecoration = "STRIKETHROUGH";
    if (node.opacity !== null && node.opacity >= 0 && node.opacity < 1) t.opacity = node.opacity;
    this.stats.texts++;

    const single = isSingleLine(style, node.h);
    if (single) {
      t.textAutoResize = "WIDTH_AND_HEIGHT";
      let ink = inkOffset(t);
      if (this.options.fitText && ink && ink.w > 0) {
        const ratio = node.w / ink.w;
        if (ratio > 0.75 && ratio < 1.33 && Math.abs(ratio - 1) > 0.01) {
          t.fontSize = Math.round(t.fontSize * ratio * 100) / 100;
          if (style.lineHeight && style.lineHeight > style.fontSize * 0.8) {
            t.lineHeight = { unit: "PIXELS", value: style.lineHeight * ratio };
          }
          ink = inkOffset(t);
        }
      }
      if (!ink) return { layer: t, rect: { x: node.x, y: node.y + (node.h - t.height) / 2, w: t.width, h: t.height } };
      // Align glyph box to the measured ink box (left/top edges; centres for centred text).
      const x = style.align === "center" ? node.x + node.w / 2 - (ink.x + ink.w / 2) : style.align === "right" ? node.x + node.w - (ink.x + ink.w) : node.x - ink.x;
      const y = node.y + node.h / 2 - (ink.y + ink.h / 2);
      return { layer: t, rect: { x, y, w: t.width, h: t.height } };
    }

    // Multi-line: fixed width just wider than the measured ink so lines break
    // where they did in the screenshot, then search the font size that gives
    // the same number of lines and the same ink box.
    t.resize(Math.max(1, node.w * 1.01 + 2), Math.max(1, node.h));
    t.textAutoResize = "HEIGHT";
    if (this.options.fitText) {
      const base = t.fontSize;
      const lh = style.lineHeight && style.lineHeight > style.fontSize * 0.8 ? style.lineHeight : null;
      let best = { size: base, score: Infinity };
      for (let k = -15; k <= 15; k++) {
        const size = Math.round(base * (1 + k / 100) * 100) / 100;
        t.fontSize = size;
        const ink = inkOffset(t);
        if (!ink) continue;
        const lines = Math.round(t.height / (lh ?? size * 1.21));
        const score = (style.lines && lines !== style.lines ? 1000 : 0) + Math.abs(ink.w - node.w) + Math.abs(ink.h - node.h) + Math.abs(k) * 0.01;
        if (score < best.score) best = { size, score };
      }
      t.fontSize = best.size;
    }
    const ink = inkOffset(t);
    if (!ink) return { layer: t, rect: { x: node.x, y: node.y, w: t.width, h: t.height } };
    const x = style.align === "center" ? node.x + node.w / 2 - t.width / 2 : style.align === "right" ? node.x + node.w - t.width : node.x - ink.x;
    return { layer: t, rect: { x, y: node.y - ink.y, w: t.width, h: t.height } };
  }

  private async buildImage(node: DesignNode): Promise<SceneNode> {
    if (node.type === "icon" && this.options.iconMode === "vector" && node.svg) {
      try {
        const vector = figma.createNodeFromSvg(node.svg);
        vector.name = node.name;
        if (vector.width > 0 && vector.height > 0) {
          vector.rescale(Math.min(node.w / vector.width, node.h / vector.height));
        }
        vector.resize(Math.max(0.01, node.w), Math.max(0.01, node.h));
        vector.fills = [];
        this.stats.images++;
        return vector;
      } catch {
        // Fall back to the cropped bitmap below.
      }
    }

    const shape = isCircle(node) ? figma.createEllipse() : figma.createRectangle();
    shape.name = node.name;
    shape.resize(Math.max(0.01, node.w), Math.max(0.01, node.h));
    applyBox(shape, { ...node, fill: null, gradient: null });
    const bytes = this.images[node.id];
    if (bytes && bytes.length > 0) {
      const imageHash = typeof bytes === "string" ? bytes : figma.createImage(bytes).hash;
      shape.fills = [{ type: "IMAGE", imageHash, scaleMode: "FILL" }];
      this.stats.images++;
    } else {
      shape.fills = [solid("#E5E7EB")];
    }
    return shape;
  }
}
