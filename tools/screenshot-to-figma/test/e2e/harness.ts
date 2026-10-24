// Node-side e2e harness.
//   prepare <name> [--no-snap]  -> out/<name>.payload.json (tree + image uploads)
//   score <name> <render.png>   -> prints match %, writes out/<name>.compare.png
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { refineColors, type Pixels } from "../../src/shared/color";
import { diffImages } from "../../src/shared/diff";
import { inkBox, snapToPixels } from "../../src/shared/snap";
import { buildTree, sanitizeAnalysis } from "../../src/shared/tree";
import type { DesignNode, Rect } from "../../src/shared/types";

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
  const tree = buildTree(analysis, px.width, px.height, raw.pixelRatio);
  refineColors(tree, px);

  const images: Record<string, string> = {};
  const walk = (list: DesignNode[]) => {
    for (const n of list) {
      if (n.type === "image" || n.type === "icon") {
        const c = crop(px, n.src);
        // Icons stay PNG (sharp edges); photos travel as high-quality JPEG to fit tool limits.
        if (n.type === "icon") {
          const png = new PNG({ width: c.width, height: c.height });
          png.data = Buffer.from(c.data);
          images[n.id] = PNG.sync.write(png).toString("base64");
        } else {
          images[n.id] = Buffer.from(jpeg.encode({ data: c.data, width: c.width, height: c.height }, 92).data).toString("base64");
        }
      }
      walk(n.children);
    }
  };
  walk(tree.children);
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
  const rows: string[] = [];
  for (const n of analysis.nodes) {
    if (n.type !== "text") continue;
    const a = inkBox(original, n, [255, 255, 255], full, 48, true);
    const b = inkBox(rendered, n, [255, 255, 255], full, 48, true);
    if (!a || !b) continue;
    const d = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(1);
    rows.push(`${n.text!.content.slice(0, 24).padEnd(24)} dx ${d(b.box.x - a.box.x)} dy ${d(b.box.y - a.box.y)} dw ${d(b.box.w - a.box.w)} dh ${d(b.box.h - a.box.h)} lines ${a.lines}/${b.lines}`);
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
