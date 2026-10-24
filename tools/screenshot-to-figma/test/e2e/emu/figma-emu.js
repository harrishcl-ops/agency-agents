// Minimal Figma Plugin API emulator for visual tests. Implements the subset
// the Screen2Figma renderer uses, with Figma's auto-layout rules, and paints
// the resulting node tree as absolutely positioned DOM so it can be
// screenshotted and diffed. Text is measured with the same font (Inter) via
// the DOM and canvas (glyph ink bounds for absoluteRenderBounds).
(() => {
  const measureHost = document.createElement("div");
  measureHost.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden";
  document.body.appendChild(measureHost);
  const ctx = document.createElement("canvas").getContext("2d");

  const STYLE_WEIGHT = { Thin: 100, "Extra Light": 200, Light: 300, Regular: 400, Medium: 500, "Semi Bold": 600, Bold: 700, "Extra Bold": 800, Black: 900 };
  const fontCss = (n) => {
    const style = n.fontName.style.replace(" Italic", "").replace("Italic", "Regular");
    return `${/Italic/.test(n.fontName.style) ? "italic " : ""}${STYLE_WEIGHT[style] ?? 400} ${n.fontSize}px "${n.fontName.family}"`;
  };
  const lineHeightPx = (n) => (n.lineHeight && n.lineHeight.unit === "PIXELS" ? n.lineHeight.value : null);
  const letterPx = (n) => (n.letterSpacing && n.letterSpacing.unit === "PIXELS" ? n.letterSpacing.value : 0);

  function textStyle(n, el) {
    el.style.font = fontCss(n);
    const lh = lineHeightPx(n);
    el.style.lineHeight = lh ? `${lh}px` : "normal";
    el.style.letterSpacing = `${letterPx(n)}px`;
    el.style.textAlign = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" }[n.textAlignHorizontal];
    el.style.textDecoration = { NONE: "none", UNDERLINE: "underline", STRIKETHROUGH: "line-through" }[n.textDecoration];
    el.style.fontKerning = "normal";
    el.style.fontFeatureSettings = '"kern" 1, "liga" 1, "calt" 1';
  }

  // Self-contained text layout (like Figma's own engine): the same code
  // computes size, glyph ink bounds and paints, so they always agree.
  function layoutText(n) {
    ctx.font = fontCss(n);
    ctx.letterSpacing = `${letterPx(n)}px`;
    const fm = ctx.measureText("Hg");
    const asc = fm.fontBoundingBoxAscent;
    const desc = fm.fontBoundingBoxDescent;
    const lh = lineHeightPx(n) ?? asc + desc;
    const widthOf = (t) => ctx.measureText(t).width;
    const fixed = n.textAutoResize !== "WIDTH_AND_HEIGHT";
    const lines = [];
    for (const para of n.characters.split("\n")) {
      if (!fixed) { lines.push(para); continue; }
      let line = "";
      for (const word of para.split(/(?<= )/)) {
        const next = line + word;
        if (line && widthOf(next.trimEnd()) > n._w + 0.01) { lines.push(line.trimEnd()); line = word; }
        else line = next;
      }
      lines.push(line.trimEnd());
    }
    const boxW = fixed ? n._w : Math.max(0, ...lines.map(widthOf));
    const boxH = lines.length * lh;
    let ink = null;
    const placed = lines.map((text, i) => {
      const w = widthOf(text);
      const x = n.textAlignHorizontal === "CENTER" ? (boxW - w) / 2 : n.textAlignHorizontal === "RIGHT" ? boxW - w : 0;
      const baseline = i * lh + (lh - (asc + desc)) / 2 + asc;
      const m = ctx.measureText(text);
      if (text.trim()) {
        const r = { x0: x - m.actualBoundingBoxLeft, x1: x + m.actualBoundingBoxRight, y0: baseline - m.actualBoundingBoxAscent, y1: baseline + m.actualBoundingBoxDescent };
        ink = ink ? { x0: Math.min(ink.x0, r.x0), x1: Math.max(ink.x1, r.x1), y0: Math.min(ink.y0, r.y0), y1: Math.max(ink.y1, r.y1) } : r;
      }
      return { text, x, baseline };
    });
    return { w: boxW, h: boxH, lines: placed, ink: ink && { x: ink.x0, y: ink.y0, w: ink.x1 - ink.x0, h: ink.y1 - ink.y0 } };
  }

  let ids = 0;
  const images = new Map();

  class Node {
    constructor(type) {
      this.id = `1:${++ids}`;
      this.type = type;
      this.name = type;
      this.x = 0;
      this.y = 0;
      this._w = 100;
      this._h = 100;
      this.fills = [];
      this.strokes = [];
      this.strokeWeight = 1;
      this.strokeAlign = "INSIDE";
      this.effects = [];
      this.opacity = 1;
      this.parent = null;
      this.removed = false;
      this.layoutPositioning = "AUTO";
    }
    get width() { return this._w; }
    get height() { return this._h; }
    resize(w, h) { this._w = w; this._h = h; }
    rescale(s) { this._w *= s; this._h *= s; }
    remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
    get absoluteTransform() { const a = absPos(this); return [[1, 0, a.x], [0, 1, a.y]]; }
  }
  class Frame extends Node {
    constructor() {
      super("FRAME");
      this.children = [];
      this.layoutMode = "NONE";
      this.clipsContent = true;
      this.cornerRadius = 0;
      this.itemSpacing = 0;
      this.paddingTop = this.paddingRight = this.paddingBottom = this.paddingLeft = 0;
      this.primaryAxisAlignItems = "MIN";
      this.counterAxisAlignItems = "MIN";
      this.primaryAxisSizingMode = "FIXED";
      this.counterAxisSizingMode = "FIXED";
    }
    appendChild(c) { if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c); c.parent = this; this.children.push(c); }
  }
  class Shape extends Node { constructor(type) { super(type); this.cornerRadius = 0; } }
  class Text extends Node {
    constructor() {
      super("TEXT");
      this.fontName = { family: "Inter", style: "Regular" };
      this.characters = "";
      this.fontSize = 12;
      this.lineHeight = { unit: "AUTO" };
      this.letterSpacing = { unit: "PIXELS", value: 0 };
      this.textAlignHorizontal = "LEFT";
      this.textDecoration = "NONE";
      this.textAutoResize = "WIDTH_AND_HEIGHT";
      this.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }];
    }
    clone() {
      const c = new Text();
      for (const k of ["fontName", "characters", "fontSize", "lineHeight", "letterSpacing", "textAlignHorizontal", "textDecoration", "textAutoResize", "fills", "_w", "_h", "x", "y"]) c[k] = this[k];
      return c;
    }
    get width() { return this.textAutoResize === "WIDTH_AND_HEIGHT" ? layoutText(this).w : this._w; }
    get height() { return this.textAutoResize === "NONE" ? this._h : layoutText(this).h; }
    get absoluteRenderBounds() {
      const m = layoutText(this);
      if (!m.ink) return null;
      const a = absPos(this);
      return { x: a.x + m.ink.x, y: a.y + m.ink.y, width: m.ink.w, height: m.ink.h };
    }
  }

  // Figma auto layout (fixed-size frames, fixed/hug children as measured).
  function layout(frame) {
    if (frame.type !== "FRAME") return;
    if (frame.layoutMode !== "NONE") {
      const H = frame.layoutMode === "HORIZONTAL";
      const flow = frame.children.filter((c) => c.layoutPositioning !== "ABSOLUTE");
      const size = (c) => (H ? c.width : c.height);
      const csize = (c) => (H ? c.height : c.width);
      const padS = H ? frame.paddingLeft : frame.paddingTop;
      const padE = H ? frame.paddingRight : frame.paddingBottom;
      const cpadS = H ? frame.paddingTop : frame.paddingLeft;
      const cpadE = H ? frame.paddingBottom : frame.paddingRight;
      const inner = (H ? frame.width : frame.height) - padS - padE;
      const cinner = (H ? frame.height : frame.width) - cpadS - cpadE;
      const sum = flow.reduce((s, c) => s + size(c), 0);
      let gap = frame.itemSpacing;
      let pos = padS;
      const total = sum + gap * Math.max(0, flow.length - 1);
      if (frame.primaryAxisAlignItems === "CENTER") pos = padS + (inner - total) / 2;
      else if (frame.primaryAxisAlignItems === "MAX") pos = padS + inner - total;
      else if (frame.primaryAxisAlignItems === "SPACE_BETWEEN" && flow.length > 1) gap = (inner - sum) / (flow.length - 1);
      for (const c of flow) {
        const cp = frame.counterAxisAlignItems === "CENTER" ? cpadS + (cinner - csize(c)) / 2 : frame.counterAxisAlignItems === "MAX" ? cpadS + cinner - csize(c) : cpadS;
        if (H) { c.x = pos; c.y = cp; } else { c.x = cp; c.y = pos; }
        pos += size(c) + gap;
      }
    }
    frame.children.forEach(layout);
  }

  function absPos(n) {
    let x = 0, y = 0, cur = n;
    while (cur) { x += cur.x; y += cur.y; cur = cur.parent; }
    return { x, y };
  }

  const rgba = (c, a = 1) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
  function background(n) {
    const layers = [];
    for (const p of [...n.fills].reverse()) {
      if (p.visible === false) continue;
      if (p.type === "SOLID") layers.push(`linear-gradient(${rgba(p.color, p.opacity ?? 1)},${rgba(p.color, p.opacity ?? 1)})`);
      else if (p.type === "GRADIENT_LINEAR") {
        const [[cos, sin]] = p.gradientTransform;
        const angle = (Math.atan2(sin, cos) * 180) / Math.PI + 90;
        layers.push(`linear-gradient(${angle}deg, ${p.gradientStops.map((s) => `${rgba(s.color, s.color.a)} ${s.position * 100}%`).join(",")})`);
      } else if (p.type === "IMAGE") layers.push(`url(${images.get(p.imageHash)}) center / cover no-repeat`);
    }
    return layers.reverse().join(",");
  }

  let overlay = null;
  function paint(n, host) {
    if (n.removed) return;
    const el = document.createElement("div");
    el.style.cssText = `position:absolute;left:${n.x}px;top:${n.y}px;box-sizing:border-box;`;
    if (n.opacity < 1) el.style.opacity = n.opacity;
    if (n.type === "TEXT") {
      // Text goes on a top-level overlay at absolute coordinates, with the
      // canvas snapped to whole device pixels and the remainder applied to the
      // glyph origin, so painting matches the measured ink exactly.
      const L = layoutText(n);
      const dpr = window.devicePixelRatio;
      const pad = Math.ceil(n.fontSize);
      const a = absPos(n);
      const left = Math.floor((a.x - pad) * dpr) / dpr;
      const top = Math.floor((a.y - pad) * dpr) / dpr;
      const c = document.createElement("canvas");
      c.width = Math.ceil((L.w + 2 * pad + 1) * dpr);
      c.height = Math.ceil((L.h + 2 * pad + 1) * dpr);
      c.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${c.width / dpr}px;height:${c.height / dpr}px;`;
      if (n.opacity < 1) c.style.opacity = n.opacity;
      const g = c.getContext("2d");
      g.scale(dpr, dpr);
      g.font = fontCss(n);
      g.letterSpacing = `${letterPx(n)}px`;
      const f = n.fills[0];
      g.fillStyle = f ? rgba(f.color, f.opacity ?? 1) : "transparent";
      for (const line of L.lines) g.fillText(line.text, a.x - left + line.x, a.y - top + line.baseline);
      overlay.appendChild(c);
      return;
    }
    el.style.width = `${n.width}px`;
    el.style.height = `${n.height}px`;
    el.style.background = background(n);
    if (n.type === "ELLIPSE") el.style.borderRadius = "50%";
    else if (n.cornerRadius) el.style.borderRadius = `${n.cornerRadius}px`;
    const shadows = [];
    for (const s of n.strokes) shadows.push(`inset 0 0 0 ${n.strokeWeight}px ${rgba(s.color, s.opacity ?? 1)}`);
    for (const e of n.effects) if (e.type === "DROP_SHADOW") shadows.push(`${e.offset.x}px ${e.offset.y}px ${e.radius}px ${e.spread ?? 0}px ${rgba(e.color, e.color.a)}`);
    if (shadows.length) el.style.boxShadow = shadows.join(",");
    if (n.type === "FRAME" && n.clipsContent) el.style.overflow = "hidden";
    host.appendChild(el);
    if (n.children) for (const c of n.children) paint(c, el);
  }

  window.figma = {
    createFrame: () => new Frame(),
    createRectangle: () => new Shape("RECTANGLE"),
    createEllipse: () => new Shape("ELLIPSE"),
    createText: () => new Text(),
    createImage: (bytes) => ({ hash: bytes }),
    createNodeFromSvg: () => { throw new Error("svg not emulated"); },
    listAvailableFontsAsync: async () => Object.keys(STYLE_WEIGHT).map((style) => ({ fontName: { family: "Inter", style } })),
    loadFontAsync: async () => undefined,
  };
  window.__emu = {
    registerImage: (hash, dataUrl) => images.set(hash, dataUrl),
    layoutAndPaint(root) {
      layout(root);
      const stage = document.getElementById("stage");
      stage.innerHTML = "";
      root.x = 0;
      root.y = 0;
      overlay = document.createElement("div");
      overlay.style.cssText = "position:absolute;left:0;top:0;";
      paint(root, stage);
      stage.firstElementChild.appendChild(overlay);
    },
  };
})();
