import { normalizeHex } from "./color";
import type {
  Analysis,
  DesignNode,
  DesignTree,
  FlatNode,
  Gradient,
  LayoutHint,
  NodeType,
  Shadow,
  TextAlign,
  TextDecoration,
  TextStyle,
} from "./types";

const NODE_TYPES: NodeType[] = ["frame", "text", "image", "icon", "rectangle", "ellipse", "line"];

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

function sanitizeText(raw: unknown): TextStyle | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const content = str(t.content);
  if (!content.trim()) return null;
  const fontSize = num(t.fontSize, 14);
  return {
    content,
    fontFamily: str(t.fontFamily, "Inter").trim() || "Inter",
    fontWeight: Math.min(900, Math.max(100, Math.round(num(t.fontWeight, 400) / 100) * 100)),
    fontSize: fontSize > 0 ? fontSize : 14,
    lineHeight: numOrNull(t.lineHeight),
    letterSpacing: numOrNull(t.letterSpacing),
    color: normalizeHex(t.color) ?? "#000000",
    align: oneOf<TextAlign>(t.align, ["left", "center", "right", "justify"], "left"),
    italic: t.italic === true,
    decoration: oneOf<TextDecoration>(t.decoration, ["none", "underline", "strikethrough"], "none"),
  };
}

function sanitizeShadow(raw: unknown): Shadow | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const color = normalizeHex(s.color);
  if (!color) return null;
  return { color, x: num(s.x), y: num(s.y), blur: Math.max(0, num(s.blur)), spread: num(s.spread) };
}

function sanitizeGradient(raw: unknown): Gradient | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  if (!Array.isArray(g.stops)) return null;
  const stops = g.stops
    .map((s) => {
      const stop = (s ?? {}) as Record<string, unknown>;
      const color = normalizeHex(stop.color);
      return color ? { color, position: Math.min(1, Math.max(0, num(stop.position))) } : null;
    })
    .filter((s): s is { color: string; position: number } => s !== null);
  if (stops.length < 2) return null;
  return { angle: num(g.angle, 180), stops };
}

/**
 * Validate one raw model node: coerce types and clamp geometry to the image.
 * Returns null for nodes that cannot be drawn. Does not resolve parents.
 */
export function sanitizeNode(raw: unknown, imageW: number, imageH: number, fallbackId: string): FlatNode | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  let type = oneOf<NodeType>(r.type, NODE_TYPES, "rectangle");
  const text = type === "text" ? sanitizeText(r.text) : null;
  if (type === "text" && !text) return null;

  let x = num(r.x);
  let y = num(r.y);
  let w = num(r.w);
  let h = num(r.h);
  // Clip to the image.
  const x2 = Math.min(imageW, x + w);
  const y2 = Math.min(imageH, y + h);
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = x2 - x;
  h = y2 - y;
  if (type === "line") {
    w = Math.max(w, 1);
    h = Math.max(h, 1);
  }
  if (w < 1 || h < 1) return null;
  if (type === "line" && w > 2 && h > 2) type = "rectangle";

  return {
    id: str(r.id).trim() || fallbackId,
    parent: str(r.parent, "root") || "root",
    type,
    name: str(r.name).trim() || defaultName(type, text),
    x,
    y,
    w,
    h,
    fill: normalizeHex(r.fill),
    gradient: sanitizeGradient(r.gradient),
    stroke: normalizeHex(r.stroke),
    strokeWidth: numOrNull(r.strokeWidth),
    radius: numOrNull(r.radius),
    shadow: sanitizeShadow(r.shadow),
    opacity: numOrNull(r.opacity),
    layout: oneOf<LayoutHint>(r.layout, ["row", "column", "none"], "none"),
    text,
    svg: type === "icon" && typeof r.svg === "string" && r.svg.includes("<svg") ? r.svg : null,
  };
}

/**
 * Re-home nodes whose parent is missing, not a frame, or part of a cycle.
 * Mutates `nodes`.
 */
export function repairParents(nodes: FlatNode[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    const parent = byId.get(n.parent);
    if (n.parent === n.id || !parent || parent.type !== "frame") n.parent = "root";
  }
  for (const n of nodes) {
    const seen = new Set<string>([n.id]);
    let cur = n;
    while (cur.parent !== "root") {
      if (seen.has(cur.parent)) {
        n.parent = "root";
        break;
      }
      seen.add(cur.parent);
      cur = byId.get(cur.parent)!;
    }
  }
}

/**
 * Validate and repair raw model output: coerce types, clamp geometry to the
 * image, de-duplicate ids, and re-home nodes whose parent is missing or cyclic.
 */
export function sanitizeAnalysis(raw: unknown, imageW: number, imageH: number): Analysis {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawNodes = Array.isArray(obj.nodes) ? obj.nodes : [];

  const nodes: FlatNode[] = [];
  const ids = new Set<string>();
  for (const item of rawNodes) {
    const node = sanitizeNode(item, imageW, imageH, `n${nodes.length}`);
    if (!node) continue;
    if (ids.has(node.id)) node.id = `${node.id}_${nodes.length}`;
    ids.add(node.id);
    nodes.push(node);
  }
  repairParents(nodes);

  return {
    screenName: str(obj.screenName).trim() || "Screen",
    background: normalizeHex(obj.background) ?? "#FFFFFF",
    nodes,
  };
}

/** Ids of `id` and all its descendants. */
export function subtreeIds(nodes: FlatNode[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (!out.has(n.id) && out.has(n.parent)) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return out;
}

function defaultName(type: NodeType, text: TextStyle | null): string {
  if (text) return text.content.slice(0, 40);
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** Scale every geometric value by `s`, then shift by (dx, dy). */
export function scaleNodes(nodes: FlatNode[], s: number, dx = 0, dy = 0): FlatNode[] {
  const sc = (v: number | null) => (v === null ? null : v * s);
  return nodes.map((n) => ({
    ...n,
    x: n.x * s + dx,
    y: n.y * s + dy,
    w: n.w * s,
    h: n.h * s,
    strokeWidth: sc(n.strokeWidth),
    radius: sc(n.radius),
    shadow: n.shadow && {
      ...n.shadow,
      x: n.shadow.x * s,
      y: n.shadow.y * s,
      blur: n.shadow.blur * s,
      spread: n.shadow.spread * s,
    },
    text: n.text && {
      ...n.text,
      fontSize: n.text.fontSize * s,
      lineHeight: sc(n.text.lineHeight),
      letterSpacing: sc(n.text.letterSpacing),
    },
  }));
}

/**
 * Merge analyses of horizontal slices of one tall screenshot. Each part must
 * already be in source-image pixels (see scaleNodes).
 */
export function mergeParts(parts: Analysis[]): Analysis {
  if (parts.length === 1) return parts[0];
  const nodes: FlatNode[] = [];
  parts.forEach((part, i) => {
    for (const n of part.nodes) {
      nodes.push({
        ...n,
        id: `p${i}_${n.id}`,
        parent: n.parent === "root" ? "root" : `p${i}_${n.parent}`,
      });
    }
  });
  return { screenName: parts[0].screenName, background: parts[0].background, nodes };
}

/**
 * Build the render tree. `analysis` is in source pixels; design units are
 * source pixels divided by `pixelRatio` (a 2x retina screenshot becomes 1x).
 */
export function buildTree(
  analysis: Analysis,
  sourceW: number,
  sourceH: number,
  pixelRatio: number,
): DesignTree {
  const k = 1 / pixelRatio;
  const scaled = scaleNodes(analysis.nodes, k);
  const byId = new Map<string, DesignNode>();
  const order: { node: DesignNode; parent: string }[] = [];

  scaled.forEach((n, i) => {
    const source = analysis.nodes[i];
    const { parent, ...rest } = n;
    const node: DesignNode = {
      ...rest,
      src: { x: source.x, y: source.y, w: source.w, h: source.h },
      children: [],
    };
    byId.set(n.id, node);
    order.push({ node, parent });
  });

  const roots: DesignNode[] = [];
  for (const { node, parent } of order) {
    const p = parent === "root" ? undefined : byId.get(parent);
    (p ? p.children : roots).push(node);
  }

  return {
    name: analysis.screenName,
    background: analysis.background,
    width: Math.round(sourceW * k),
    height: Math.round(sourceH * k),
    children: roots,
  };
}

/** Number of nodes in a tree (for progress/stats). */
export function countNodes(nodes: DesignNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}
