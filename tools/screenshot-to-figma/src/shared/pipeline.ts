// Conversion pipeline, independent of Figma and the DOM. Everything that
// touches the outside world goes through `Host`, so the logic is testable.
//
// Fast:          analyse -> snap to pixels -> render
// Pixel-perfect: analyse -> per-section detail pass -> snap -> render ->
//                [diff vs original -> Claude corrections -> snap -> render] x N

import { AnalysisError, type AnalyzeRequest, type Correction, type CorrectionRequest } from "./analyze";
import { refineColors, type Pixels } from "./color";
import { diffImages } from "./diff";
import { inpaint, matte, overlayMask, planCleanup } from "./inpaint";
import { snapToPixels } from "./snap";
import { detectPixelRatio, planSlices, splitInTwo } from "./split";
import { buildTree, mergeParts, repairParents, sanitizeNode, scaleNodes, subtreeIds } from "./tree";
import type { Analysis, ConvertOptions, DesignNode, DesignTree, FlatNode, ModelImage, Rect } from "./types";

export type Quality = "fast" | "pixel-perfect";

export interface PipelineOptions extends ConvertOptions {
  quality: Quality;
  /** Max verify/correct rounds in pixel-perfect mode. */
  maxRounds: number;
  /** Longest edge the model reads at full resolution. */
  maxEdge: number;
  /** Parallel model calls. */
  concurrency: number;
}

export interface Host {
  /** Original screenshot, full resolution RGBA. */
  pixels: Pixels;
  /** Encode `region` of `px` scaled by `scale` for the model (alpha flattened onto white). */
  encode(px: Pixels, region: Rect, scale: number): Promise<ModelImage>;
  /** PNG bytes of `region` of `px` (keeps transparency). */
  crop(px: Pixels, region: Rect): Promise<Uint8Array>;
  analyze(request: AnalyzeRequest, onProgress?: (nodes: number) => void): Promise<Analysis>;
  correct(request: CorrectionRequest): Promise<Correction>;
  /** Render in Figma (replacing the previous result) and return the export at source resolution. */
  render(tree: DesignTree, images: Record<string, Uint8Array>): Promise<Pixels>;
  status(message: string, fraction?: number): void;
  cancelled(): boolean;
}

export interface PipelineResult {
  analysis: Analysis;
  tree: DesignTree;
  pixelRatio: number;
  /** Mismatch after each render (0..1), pixel-perfect mode only. */
  mismatchHistory: number[];
}

export class CancelledError extends Error {
  constructor() {
    super("Conversion cancelled.");
    this.name = "CancelledError";
  }
}

const area = (r: Rect) => r.w * r.h;
const rectOf = (n: FlatNode): Rect => ({ x: n.x, y: n.y, w: n.w, h: n.h });

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Scale for sending `region` to the model: fit the model's max edge and a
 * ~3.6 MP budget; upscale small regions (up to 2x) so small text stays legible.
 */
export function modelScale(region: Rect, maxEdge: number): number {
  const long = Math.max(region.w, region.h);
  let s = Math.min(1, maxEdge / long, Math.sqrt(3_600_000 / Math.max(1, area(region))));
  if (long * s < 1000) s = Math.min(2, 1000 / long, maxEdge / long);
  return s;
}

export class Pipeline {
  private readonly px: Pixels;

  constructor(
    private host: Host,
    private opts: PipelineOptions,
  ) {
    this.px = host.pixels;
  }

  private check(): void {
    if (this.host.cancelled()) throw new CancelledError();
  }

  /** Analyse one region; on overflow split it in two and retry (up to depth 3). Result in source px. */
  private async analyzeRegion(
    region: Rect,
    extra: Pick<AnalyzeRequest, "part" | "section">,
    depth = 0,
  ): Promise<Analysis> {
    this.check();
    const scale = modelScale(region, this.opts.maxEdge);
    const image = await this.host.encode(this.px, region, scale);
    try {
      const result = await this.host.analyze(
        { image, platform: this.opts.platform, iconMode: this.opts.iconMode, ...extra },
        (n) => this.host.status(`Reading layout… ${n} elements found`),
      );
      return { ...result, nodes: scaleNodes(result.nodes, 1 / scale, region.x, region.y) };
    } catch (err) {
      if (err instanceof AnalysisError && err.kind === "too_many_elements" && depth < 3 && region.h > 200) {
        const [a, b] = splitInTwo(this.px, region);
        const parts = [
          await this.analyzeRegion(a, { ...extra, part: { index: 0, count: 2 } }, depth + 1),
          await this.analyzeRegion(b, { ...extra, part: { index: 1, count: 2 } }, depth + 1),
        ];
        return mergeParts(parts);
      }
      throw err;
    }
  }

  /** Pass 1: whole screenshot (tall images in slices). */
  async firstPass(): Promise<Analysis> {
    const slices = planSlices(this.px);
    this.host.status(slices.length > 1 ? `Analysing ${slices.length} parts of the page…` : "Analysing screenshot…", 0.05);
    const parts = await mapLimit(slices, this.opts.concurrency, (slice, index) =>
      this.analyzeRegion(slice, slices.length > 1 ? { part: { index, count: slices.length } } : {}),
    );
    return mergeParts(parts);
  }

  /**
   * Sections worth a detail pass: large top-level frames (descending into
   * frames that cover most of the screen) with enough content.
   */
  detailSections(analysis: Analysis): FlatNode[] {
    const total = this.px.width * this.px.height;
    const childrenOf = (id: string) => analysis.nodes.filter((n) => n.parent === id);
    const out: FlatNode[] = [];
    const visit = (list: FlatNode[]) => {
      for (const n of list) {
        if (n.type !== "frame") continue;
        if (area(rectOf(n)) > total * 0.6) visit(childrenOf(n.id));
        else if (area(rectOf(n)) >= total * 0.02 && subtreeIds(analysis.nodes, n.id).size >= 4) out.push(n);
      }
    };
    visit(childrenOf("root"));
    return out.slice(0, 24);
  }

  /** Pass 2: re-analyse each section crop at full resolution and replace its contents. */
  async detailPass(analysis: Analysis): Promise<Analysis> {
    const sections = this.detailSections(analysis);
    if (sections.length === 0) return analysis;
    let done = 0;
    const results = await mapLimit(sections, this.opts.concurrency, async (section) => {
      try {
        const detail = await this.analyzeRegion(rectOf(section), {
          section: { name: section.name, background: section.gradient ? null : section.fill },
        });
        return detail;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        return null; // keep pass-1 content for this section
      } finally {
        this.host.status(`Refining sections… ${++done}/${sections.length}`, 0.1 + 0.3 * (done / sections.length));
      }
    });

    let nodes = analysis.nodes;
    sections.forEach((section, i) => {
      const detail = results[i];
      if (!detail || detail.nodes.length === 0) return;
      const old = subtreeIds(nodes, section.id);
      old.delete(section.id);
      const prefix = `${section.id}~`;
      const fresh = detail.nodes.map((n) => ({
        ...n,
        id: prefix + n.id,
        parent: n.parent === "root" ? section.id : prefix + n.parent,
      }));
      const kept = nodes.filter((n) => !old.has(n.id));
      const insertAt = kept.findIndex((n) => n.id === section.id) + 1;
      nodes = [...kept.slice(0, insertAt), ...fresh, ...kept.slice(insertAt)];
    });
    repairParents(nodes);
    return { ...analysis, nodes };
  }

  async buildRenderable(analysis: Analysis, pixelRatio: number): Promise<{ tree: DesignTree; images: Record<string, Uint8Array> }> {
    const tree = buildTree(analysis, this.px.width, this.px.height, pixelRatio);
    refineColors(tree, this.px);
    const images: Record<string, Uint8Array> = {};
    for (const [id, source] of bitmapSources(tree, this.px, this.opts.iconMode)) {
      this.check();
      images[id] = await this.host.crop(source.px, source.region);
    }
    return { tree, images };
  }

  /** Regions to verify: detail sections (or top-level frames) plus the whole screen. */
  private verifyRegions(analysis: Analysis): { rect: Rect; owner: string | null }[] {
    const sections = this.detailSections(analysis);
    const regions: { rect: Rect; owner: string | null }[] = sections.map((s) => ({ rect: rectOf(s), owner: s.id }));
    if (this.px.height <= this.px.width * 2.2) {
      regions.push({ rect: { x: 0, y: 0, w: this.px.width, h: this.px.height }, owner: null });
    }
    return regions;
  }

  /** Nodes shown to the model for a region, in region-model coordinates. */
  private regionNodes(analysis: Analysis, owner: string | null, region: Rect, scale: number): FlatNode[] {
    const ids = owner ? subtreeIds(analysis.nodes, owner) : new Set(analysis.nodes.filter((n) => n.parent === "root").map((n) => n.id));
    const local = analysis.nodes.filter((n) => ids.has(n.id));
    const shifted = scaleNodes(local, 1, -region.x, -region.y);
    return scaleNodes(shifted, scale).map((n) => ({
      ...n,
      parent: owner && n.id === owner ? "root" : owner && n.parent === owner ? owner : n.parent,
      svg: this.opts.iconMode === "vector" ? n.svg : null,
      x: Math.round(n.x * 10) / 10,
      y: Math.round(n.y * 10) / 10,
      w: Math.round(n.w * 10) / 10,
      h: Math.round(n.h * 10) / 10,
    }));
  }

  /** Apply a correction (region-model coordinates) to the source-px analysis. */
  applyCorrection(analysis: Analysis, c: Correction, owner: string | null, region: Rect, scale: number): Analysis {
    const regionW = region.w * scale;
    const regionH = region.h * scale;
    const toSource = (raw: unknown[], prefix: string) =>
      scaleNodes(
        raw
          .map((r, i) => sanitizeNode(r, regionW, regionH, `${prefix}${i}`))
          .filter((n): n is FlatNode => n !== null),
        1 / scale,
        region.x,
        region.y,
      );

    let nodes = [...analysis.nodes];
    const allowed = owner ? subtreeIds(nodes, owner) : new Set(nodes.map((n) => n.id));

    // Deletions (never the region owner itself).
    for (const id of c.deletions) {
      if (!allowed.has(id) || id === owner) continue;
      const drop = subtreeIds(nodes, id);
      nodes = nodes.filter((n) => !drop.has(n.id));
    }

    const homeParent = (p: string) => (p === "root" ? owner ?? "root" : p);
    for (const u of toSource(c.updates, "u")) {
      const i = nodes.findIndex((n) => n.id === u.id);
      if (i >= 0 && allowed.has(u.id)) {
        const parent = u.id === owner ? nodes[i].parent : homeParent(u.parent);
        nodes[i] = { ...u, parent };
      }
    }
    const ids = new Set(nodes.map((n) => n.id));
    for (const a of toSource(c.additions, "a")) {
      let id = a.id;
      while (ids.has(id)) id = `${id}+`;
      ids.add(id);
      nodes.push({ ...a, id, parent: homeParent(a.parent) });
    }
    repairParents(nodes);
    return { ...analysis, nodes };
  }

  /** Device pixel ratio used to map screenshot pixels to design units. */
  resolvePixelRatio(): number {
    const { opts } = this;
    return opts.pixelRatio > 0 ? opts.pixelRatio : detectPixelRatio(this.px.width, this.px.height, opts.platform);
  }

  async run(): Promise<PipelineResult> {
    const { opts, host } = this;
    const pixelRatio = this.resolvePixelRatio();

    let analysis = await this.firstPass();
    this.check();
    if (opts.quality === "pixel-perfect") analysis = await this.detailPass(analysis);
    this.check();
    host.status("Measuring pixels…", 0.45);
    analysis = snapToPixels(analysis, this.px);

    host.status("Building Figma layers…", 0.5);
    let built = await this.buildRenderable(analysis, pixelRatio);
    let rendered = await host.render(built.tree, built.images);
    const history: number[] = [];

    if (opts.quality === "pixel-perfect") {
      let best = { analysis, built, mismatch: diffImages(this.px, rendered).mismatch };
      history.push(best.mismatch);

      for (let round = 1; round <= opts.maxRounds; round++) {
        this.check();
        const regions = this.verifyRegions(best.analysis)
          .map((r) => ({ ...r, diff: diffImages(this.px, rendered, r.rect) }))
          .filter((r) => r.diff.badCells > 0 || r.diff.mismatch > 0.02);
        if (regions.length === 0) break;

        host.status(`Checking against the original (round ${round}/${opts.maxRounds})…`, 0.55 + (0.4 * (round - 1)) / opts.maxRounds);
        let current = best.analysis;
        const corrections = await mapLimit(regions, opts.concurrency, async (r) => {
          const scale = modelScale(r.rect, opts.maxEdge);
          const maskRect = { x: 0, y: 0, w: r.diff.mask.width, h: r.diff.mask.height };
          try {
            const correction = await host.correct({
              original: await host.encode(this.px, r.rect, scale),
              rendered: await host.encode(rendered, r.rect, scale),
              mask: await host.encode(r.diff.mask, maskRect, scale),
              nodes: this.regionNodes(current, r.owner, r.rect, scale),
              mismatch: r.diff.mismatch,
              iconMode: opts.iconMode,
            });
            return { r, scale, correction };
          } catch (err) {
            if (err instanceof CancelledError) throw err;
            return null;
          }
        });
        for (const item of corrections) {
          if (!item) continue;
          current = this.applyCorrection(current, item.correction, item.r.owner, item.r.rect, item.scale);
        }
        current = snapToPixels(current, this.px);

        host.status(`Re-rendering (round ${round})…`);
        const nextBuilt = await this.buildRenderable(current, pixelRatio);
        rendered = await host.render(nextBuilt.tree, nextBuilt.images);
        const mismatch = diffImages(this.px, rendered).mismatch;
        history.push(mismatch);

        if (mismatch < best.mismatch - 0.001) {
          best = { analysis: current, built: nextBuilt, mismatch };
        } else {
          // No improvement: restore the best version and stop.
          rendered = await host.render(best.built.tree, best.built.images);
          break;
        }
      }
      analysis = best.analysis;
      built = best.built;
    }

    // Missing fonts: show exact images of text that still differs, live text kept hidden.
    const marked = markUnmatchedFonts(analysis, this.px, rendered);
    if (marked > 0) {
      host.status(`Keeping ${marked} text layer(s) in a missing font as exact images…`);
      built = await this.buildRenderable(analysis, pixelRatio);
      rendered = await host.render(built.tree, built.images);
      if (opts.quality === "pixel-perfect") history.push(diffImages(this.px, rendered).mismatch);
    }

    host.status("Done", 1);
    return { analysis, tree: built.tree, pixelRatio, mismatchHistory: history };
  }
}

/**
 * Where each image/icon layer's bitmap comes from: the original screenshot,
 * the cleaned background (overlaid text/icons/outlines inpainted away), or a
 * transparent matte for icons drawn over photos.
 */
export function bitmapSources(tree: DesignTree, px: Pixels, iconMode: ConvertOptions["iconMode"]): Map<string, { px: Pixels; region: Rect }> {
  const plan = planCleanup(tree, px);
  const clean = plan.overlays.length > 0 ? inpaint(px, overlayMask(px, plan.overlays)) : px;
  const out = new Map<string, { px: Pixels; region: Rect }>();
  const walk = (list: DesignNode[]) => {
    for (const n of list) {
      if (n.type === "text" && n.text?.raster) {
        const pad = 2;
        const region = { x: n.src.x - pad, y: n.src.y - pad, w: n.src.w + 2 * pad, h: n.src.h + 2 * pad };
        const m = matte(px, clean, region, hexToRgbTuple(n.text.color));
        out.set(n.id, m ? { px: m, region: { x: 0, y: 0, w: m.width, h: m.height } } : { px, region });
      }
      if (n.type === "image" || (n.type === "icon" && !(iconMode === "vector" && n.svg))) {
        const ink = plan.icons.get(n.id);
        const m = ink ? matte(px, clean, n.src, ink) : null;
        if (m) out.set(n.id, { px: m, region: { x: 0, y: 0, w: m.width, h: m.height } });
        else out.set(n.id, { px: plan.images.has(n.id) ? clean : px, region: n.src });
      }
      walk(n.children);
    }
  };
  walk(tree.children);
  return out;
}

const hexToRgbTuple = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/**
 * Text whose glyphs still differ in whole blocks after fitting is set in a
 * font Figma doesn't have (brand typefaces, wordmarks). Mark it to be shown as
 * an exact image with the live text kept underneath. Returns how many.
 */
export function markUnmatchedFonts(analysis: Analysis, original: Pixels, rendered: Pixels): number {
  let marked = 0;
  for (const n of analysis.nodes) {
    if (n.type !== "text" || !n.text || n.text.raster) continue;
    const box = { x: n.x - 2, y: n.y - 2, w: n.w + 4, h: n.h + 4 };
    const d = diffImages(original, rendered, box);
    const cells = Math.max(1, (box.w / 12) * (box.h / 12));
    if (d.badCells >= 6 && d.badCells / cells >= 0.08) {
      n.text = { ...n.text, raster: true };
      marked++;
    }
  }
  return marked;
}
