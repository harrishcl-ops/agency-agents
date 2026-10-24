// Node-side e2e harness.
//   prepare <name> [--no-snap]  -> out/<name>.payload.json (tree + image uploads)
//   score <name> <render.png>   -> prints match %, writes out/<name>.compare.png
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { hexToRgba, refineColors, type Pixels } from "../../src/shared/color";
import { diffImages } from "../../src/shared/diff";
import { inkBox, snapToPixels } from "../../src/shared/snap";
import { buildTree, sanitizeAnalysis } from "../../src/shared/tree";
import { assetsFor, markUnmatchedFonts } from "../../src/shared/pipeline";
import type { DesignNode } from "../../src/shared/types";
import type { Rect } from "../../src/shared/types";

const out = join(process.cwd(), "test/e2e/out");
const readPng = (path: string): Pixels => {
  const png = PNG.sync.read(readFileSync(path));
  return { data: png.data, width: png.width, height: png.height };
};
const writePng = (path: string, px: Pixels) => {
  const png = new PNG({ width: px.width, height: px.height });
  png.data = Buffer.from(px.data);
  writeFileSync(path, PNG.sync.write(png));
};

function crop(px: Pixels, r: Rect): Pixels {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const w = Math.max(1, Math.min(px.width - x0, Math.ceil(r.x + r.w) - x0));
  const h = Math.max(1, Math.min(px.height - y0, Math.ceil(r.y + r.h) - y0));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(px.data.subarray(((y0 + y) * px.width + x0) * 4, ((y0 + y) * px.width + x0 + w) * 4), y * w * 4);
  return { data, width: w, height: h };
}

const [cmd, name, arg] = process.argv.slice(2);

if (cmd === "prepare") {
  const px = readPng(join(out, `${name}.png`));
  const raw = JSON.parse(readFileSync(join(out, `${name}.model.json`), "utf8"));
  let analysis = sanitizeAnalysis(raw, px.width, px.height);
  if (arg !== "--no-snap") analysis = snapToPixels(analysis, px);
  if (process.env.MARK_FROM) {
    const marked = markUnmatchedFonts(analysis, px, readPng(process.env.MARK_FROM));
    console.log(`marked ${marked} text layer(s) as missing-font images: ${analysis.nodes.filter((n) => n.text?.raster).map((n) => n.name).join(", ")}`);
  }
  const tree = buildTree(analysis, px.width, px.height, raw.pixelRatio);
  refineColors(tree, px);

  const images: Record<string, string> = {};
  const assets = assetsFor(tree, px, (process.env.ICONS as "vector" | "image") ?? "vector");
  const setSvg = (list: DesignNode[]) => list.forEach((n) => { const a = assets.get(n.id); n.svg = a?.kind === "vector" ? a.svg : null; setSvg(n.children); });
  setSvg(tree.children);
  for (const [id, source] of assets) {
    if (source.kind === "vector") {
      if (process.env.DUMP) writeFileSync(join(out, `${name}.vector-${id}.svg`), source.svg);
      continue;
    }
    const c = crop(source.px, source.region);
    let transparent = false;
    for (let i = 3; i < c.data.length; i += 4) if (c.data[i] < 255) { transparent = true; break; }
    // Transparent or small bitmaps stay PNG; large opaque photos travel as JPEG.
    if (transparent || c.width * c.height < 40000 || process.env.S2F) {
      const png = new PNG({ width: c.width, height: c.height });
      png.data = Buffer.from(c.data);
      images[id] = PNG.sync.write(png).toString("base64");
    } else {
      images[id] = Buffer.from(jpeg.encode({ data: c.data, width: c.width, height: c.height }, 92).data).toString("base64");
    }
    if (process.env.DUMP) writePng(join(out, `${name}.bitmap-${id}.png`), c);
  }
  if (process.env.S2F) {
    const s2f = {
      format: "screen2figma",
      version: 1,
      name: tree.name,
      pixelRatio: raw.pixelRatio,
      tree,
      images,
      reference: readFileSync(join(out, `${name}.png`)).toString("base64"),
    };
    writeFileSync(join(out, `${name}.s2f.json`), JSON.stringify(s2f));
    console.log(`wrote ${name}.s2f.json`);
  }
  const suffix = arg === "--no-snap" ? ".nosnap" : "";
  writeFileSync(join(out, `${name}${suffix}.payload.json`), JSON.stringify({ tree, images, pixelRatio: raw.pixelRatio }));
  const sizes = Object.entries(images).map(([k, v]) => `${k}:${(v.length / 1024).toFixed(0)}k`);
  console.log(`${name}${suffix}: tree ${(JSON.stringify(tree).length / 1024).toFixed(1)}k, images ${sizes.join(" ")}`);
} else if (cmd === "offsets") {
  // Per text layer: ink box in the original vs the render (source px).
  const original = readPng(join(out, `${name}.png`));
  const rendered = readPng(arg);
  const raw = JSON.parse(readFileSync(join(out, `${name}.model.json`), "utf8"));
  const analysis = snapToPixels(sanitizeAnalysis(raw, original.width, original.height), original);
  const full = { x: 0, y: 0, w: original.width, h: original.height };
  const screenBg = hexToRgba(analysis.background);
  const bgOf = (_n: unknown): [number, number, number] => [screenBg.r * 255, screenBg.g * 255, screenBg.b * 255];
  const rows: string[] = [];
  for (const n of analysis.nodes) {
    if (n.type !== "text") continue;
    const box = { x: n.x - 2, y: n.y - 2, w: n.w + 4, h: n.h + 4 };
    const dd = diffImages(original, rendered, box);
    const cells = Math.max(1, Math.round((box.w / 12) * (box.h / 12)));
    rows.push(`CELLS ${n.text!.content.slice(0, 20).padEnd(20)} badCells ${dd.badCells}/${cells} = ${((dd.badCells / cells) * 100).toFixed(1)}%  h ${n.h.toFixed(0)}`);
    const a = inkBox(original, n, bgOf(n), full, 48, true);
    const b = inkBox(rendered, n, bgOf(n), full, 48, true);
    if (!a || !b) continue;
    const d = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(1);
    const m = diffImages(original, rendered, { x: a.box.x - 2, y: a.box.y - 2, w: a.box.w + 4, h: a.box.h + 4 }).mismatch;
    rows.push(`${n.text!.content.slice(0, 24).padEnd(24)} mismatch ${(m * 100).toFixed(1).padStart(5)}% dx ${d(b.box.x - a.box.x)} dy ${d(b.box.y - a.box.y)} dw ${d(b.box.w - a.box.w)} dh ${d(b.box.h - a.box.h)} lines ${a.lines}/${b.lines}`);
  }
  console.log(rows.join("\n"));
} else if (cmd === "score") {
  const original = readPng(join(out, `${name}.png`));
  const rendered = readPng(arg);
  if (rendered.width !== original.width || rendered.height !== original.height) {
    console.log(`size mismatch: render ${rendered.width}x${rendered.height} vs original ${original.width}x${original.height}`);
  }
  const d = diffImages(original, rendered);
  console.log(`${name}: match ${((1 - d.mismatch) * 100).toFixed(2)}%  mismatched ${(d.mismatch * 100).toFixed(2)}%  bad cells ${d.badCells}`);
  // Side by side: original | render | mask.
  const W = original.width, H = original.height;
  const sbs = { data: new Uint8Array(W * 3 * H * 4), width: W * 3, height: H };
  for (let y = 0; y < H; y++) {
    for (const [k, img] of [original, rendered, d.mask].entries()) {
      if (y >= img.height) continue;
      const w = Math.min(W, img.width);
      sbs.data.set(img.data.subarray(y * img.width * 4, (y * img.width + w) * 4), (y * W * 3 + k * W) * 4);
    }
  }
  writePng(join(out, `${name}.compare.png`), sbs);
  writePng(join(out, `${name}.mask.png`), d.mask);
}
