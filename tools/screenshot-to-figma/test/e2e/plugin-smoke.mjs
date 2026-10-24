// Whole-plugin smoke test: loads the built plugin (dist/code.js + dist/ui.html)
// into the Figma emulator, imports a .s2f.json through the real UI, and checks
// the result on the canvas (and paints it for a visual score).
//   node test/e2e/plugin-smoke.mjs <name>     (needs out/<name>.s2f.json; run `npm run build` first)
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [name] = process.argv.slice(2);
const out = "test/e2e/out";
const doc = JSON.parse(readFileSync(join(out, `${name}.s2f.json`), "utf8"));
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: Math.max(1600, doc.tree.width + 400), height: Math.max(900, doc.tree.height) }, deviceScaleFactor: doc.pixelRatio });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("file://" + join(process.cwd(), "test/e2e/emu/stage.html"));
await page.evaluate(async () => { for (const w of [400, 500, 600, 700]) await document.fonts.load(`${w} 16px Inter`); });
await page.addScriptTag({ path: "test/e2e/emu/figma-emu.js" });
const html = readFileSync("dist/ui.html", "utf8");
await page.evaluate((html) => { window.__html__ = html; }, html);
await page.addScriptTag({ path: "dist/code.js" });

const ui = page.frameLocator("iframe");
await ui.locator("#importS2f").waitFor();
await ui.locator("#s2fFile").setInputFiles(join(out, `${name}.s2f.json`));
await ui.locator("#status", { hasText: /Imported|error|isn't/i }).waitFor({ timeout: 120000 });
const status = await ui.locator("#status").textContent();

const result = await page.evaluate(() => {
  const kids = figma.currentPage.children.filter((n) => !n.removed && !n.parent);
  const frame = kids.find((n) => n.type === "FRAME");
  const count = (n) => 1 + (n.children ?? []).reduce((s, c) => s + count(c), 0);
  const names = [];
  const walk = (n, d) => { names.push(`${"  ".repeat(d)}${n.type} ${n.name}${n.visible === false ? " (hidden)" : ""}${n.layoutMode && n.layoutMode !== "NONE" ? ` [auto-layout ${n.layoutMode.toLowerCase()}]` : ""}`); (n.children ?? []).forEach((c) => walk(c, d + 1)); };
  if (frame) walk(frame, 0);
  const reference = kids.find((n) => n.type === "RECTANGLE" && /original screenshot/.test(n.name));
  if (frame) { frame.x = 0; frame.y = 0; window.__emu.layoutAndPaint(frame); }
  return { topLevel: kids.length, layers: frame ? count(frame) : 0, reference: !!reference, tree: names };
});
await page.waitForTimeout(300);
const file = join(out, `${name}.plugin.png`);
await page.locator("#stage > div").first().screenshot({ path: file });
await browser.close();
console.log(`status: ${status}`);
console.log(`canvas: ${result.topLevel} top-level nodes, ${result.layers} layers in design, reference beside it: ${result.reference}`);
console.log(result.tree.join("\n"));
if (errors.length) console.log("page errors:", errors);
console.log(execFileSync("node", [join(out, "harness.mjs"), "score", name, file], { encoding: "utf8" }).trim());
