// Shared data model for Screen2Figma.
//
// The model returns a FLAT list of nodes (structured outputs do not allow
// recursive schemas); `buildTree` turns it into a DesignNode tree.

export type NodeType =
  | "frame"
  | "text"
  | "image"
  | "icon"
  | "rectangle"
  | "ellipse"
  | "line";

export type LayoutHint = "row" | "column" | "none";
export type TextAlign = "left" | "center" | "right" | "justify";
export type TextDecoration = "none" | "underline" | "strikethrough";
export type Platform = "auto" | "web" | "mobile" | "tablet";

export interface TextStyle {
  content: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeight: number | null;
  letterSpacing: number | null;
  color: string;
  align: TextAlign;
  italic: boolean;
  decoration: TextDecoration;
}

export interface Shadow {
  color: string;
  x: number;
  y: number;
  blur: number;
  spread: number;
}

export interface GradientStop {
  color: string;
  position: number;
}

export interface Gradient {
  angle: number;
  stops: GradientStop[];
}

/** One element as emitted by the model. Coordinates are absolute image pixels. */
export interface FlatNode {
  id: string;
  parent: string;
  type: NodeType;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string | null;
  gradient: Gradient | null;
  stroke: string | null;
  strokeWidth: number | null;
  radius: number | null;
  shadow: Shadow | null;
  opacity: number | null;
  layout: LayoutHint;
  text: TextStyle | null;
  svg: string | null;
}

export interface Analysis {
  screenName: string;
  background: string;
  nodes: FlatNode[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Tree node in design units, ready to render. */
export interface DesignNode extends Omit<FlatNode, "parent"> {
  /** Region of the ORIGINAL screenshot (in source pixels) this node covers. */
  src: Rect;
  children: DesignNode[];
}

export interface DesignTree {
  name: string;
  background: string;
  width: number;
  height: number;
  children: DesignNode[];
}

export type IconMode = "image" | "vector";

export interface ConvertOptions {
  platform: Platform;
  /** Device pixel ratio of the screenshot; 0 = auto-detect. */
  pixelRatio: number;
  autoLayout: boolean;
  iconMode: IconMode;
  addReference: boolean;
}

export interface ModelOptions {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}

/** Image payload sent to the model (already downscaled to fit). */
export interface ModelImage {
  base64: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}
