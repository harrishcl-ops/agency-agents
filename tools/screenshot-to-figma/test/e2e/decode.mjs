// Decode any browser-readable image (WebP, AVIF, ...) to PNG with Chromium.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
const [input, output] = process.argv.slice(2);
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage();
const b64 = readFileSync(input).toString("base64");
const dataUrl = await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes]));
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
  return c.toDataURL("image/png");
}, b64);
writeFileSync(output, Buffer.from(dataUrl.split(",")[1], "base64"));
await browser.close();
