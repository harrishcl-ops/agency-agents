// Trace mattes and measure fidelity by rasterising the SVG back (Chromium).
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { chromium } from "playwright";
import { traceMatte } from "../../src/shared/trace";

const files = process.argv.slice(2);
const EPS = Number(process.env.EPS ?? 0.18);
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage();
for (const file of files) {
  const png = PNG.sync.read(readFileSync(file));
  const m = { data: png.data, width: png.width, height: png.height };
  const t = traceMatte(m, "#FFFFFF", EPS);
  if (!t) { console.log(file, "nothing traced"); continue; }
  writeFileSync(file.replace(/\.png$/, ".svg"), t.svg);
  const alpha = await page.evaluate(async ({ svg, w, h }) => {
    const img = new Image();
    img.src = "data:image/svg+xml;base64," + btoa(svg);
    await img.decode();
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d")!; g.drawImage(img, 0, 0, w, h);
    return Array.from(g.getImageData(0, 0, w, h).data.filter((_, i) => i % 4 === 3));
  }, { svg: t.svg, w: m.width, h: m.height });
  let err = 0, big = 0, ink = 0;
  for (let i = 0; i < alpha.length; i++) {
    const a = m.data[i * 4 + 3];
    const d = Math.abs(alpha[i] - a);
    err += d; if (d > 128) big++; if (a > 128) ink++;
  }
  console.log(`${file.split("/").pop()}: ${t.contours} contours, ${(t.svg.length / 1024).toFixed(1)} KB svg, mean alpha error ${(err / alpha.length / 2.55).toFixed(2)}%, pixels flipped ${big} of ${ink} ink px (${((big / Math.max(1, ink)) * 100).toFixed(2)}%)`);
}
await browser.close();
