// Render a prepared payload with the real renderer bundle inside the Figma
// emulator, screenshot it at the source pixel ratio and score it.
//   node test/e2e/emu/run.mjs <name> [payloadSuffix] [--no-autolayout]
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [name, suffix = "", flag] = process.argv.slice(2);
const out = "test/e2e/out";
const payload = JSON.parse(readFileSync(join(out, `${name}${suffix}.payload.json`), "utf8"));
const { tree, pixelRatio } = payload;

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: Math.round(tree.width), height: Math.round(tree.height) }, deviceScaleFactor: pixelRatio });
await page.goto("file://" + join(process.cwd(), "test/e2e/emu/stage.html"));
await page.evaluate(() => document.fonts.ready);
await page.evaluate(async () => {
  for (const w of [400, 500, 600, 700]) await document.fonts.load(`${w} 16px Inter`);
});
await page.addScriptTag({ path: "test/e2e/emu/figma-emu.js" });
await page.addScriptTag({ path: join(out, "renderer.min.js") });
const tolerance = Number(process.env.TOL ?? 1) / pixelRatio;
const stats = await page.evaluate(async ({ tree, images, autoLayout, tolerance }) => {
  const hashes = {};
  for (const [id, b64] of Object.entries(images)) {
    const mime = b64.startsWith("iVBOR") ? "image/png" : "image/jpeg";
    window.__emu.registerImage(`h_${id}`, `data:${mime};base64,${b64}`);
    hashes[id] = `h_${id}`;
  }
  const { frame, stats } = await window.S2F.render(tree, hashes, { autoLayout, iconMode: "image", layoutTolerance: tolerance, fitText: true });
  window.__emu.layoutAndPaint(frame);
  await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
  return stats;
}, { tree, images: payload.images, autoLayout: flag !== "--no-autolayout", tolerance });
await page.waitForTimeout(300);
const file = join(out, `${name}${suffix}.render.png`);
await page.locator("#stage > div").first().screenshot({ path: file });
await browser.close();
console.log(`${name}${suffix}: tolerance ${tolerance.toFixed(2)}, layers ${stats.layers}, auto-layout frames ${stats.autoLayoutFrames}, images ${stats.images}, failed ${stats.failed}`);
console.log(execFileSync("node", [join(out, "harness.mjs"), "score", name, file], { encoding: "utf8" }).trim());
