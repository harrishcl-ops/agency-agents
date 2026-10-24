// Renders the fixtures with Chromium and writes, per fixture:
//   out/<name>.png         the screenshot (device pixels)
//   out/<name>.model.json  a simulated *imprecise* model analysis (source px):
//                          element boxes from the DOM with seeded random errors
//                          in position, size, colour and font size, so the
//                          pipeline's pixel snapping/fitting has to recover.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
await mkdir(out, { recursive: true });

const FIXTURES = [
  { name: "landing", width: 1440, height: 900, dpr: 1 },
  { name: "mobile", width: 390, height: 844, dpr: 3 },
  { name: "dashboard", width: 1280, height: 800, dpr: 2 },
  // Windows-style fractional scaling.
  { name: "landing150", page: "landing", width: 1440, height: 900, dpr: 1.5 },
];

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
for (const f of FIXTURES) {
  const page = await browser.newPage({ viewport: { width: f.width, height: f.height }, deviceScaleFactor: f.dpr });
  await page.goto("file://" + join(here, "fixtures", `${f.page ?? f.name}.html`));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(out, `${f.name}${process.env.NOISE === "0" ? "-ideal" : ""}.png`) });

  const analysis = await page.evaluate(({ dpr, seed, noise }) => {
    let s = seed >>> 0;
    const rnd = () => noise * (((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1); // -1..1
    const jitter = (v, amount) => v + rnd() * amount;

    const parseColor = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      if (a === 0) return null;
      const hex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
      return "#" + hex(r) + hex(g) + hex(b) + (a < 1 ? hex(a * 255) : "");
    };
    const noisyColor = (hex) => {
      if (!hex) return hex;
      const ch = (i) => parseInt(hex.slice(i, i + 2), 16);
      const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
      return "#" + h(ch(1) + rnd() * 8) + h(ch(3) + rnd() * 8) + h(ch(5) + rnd() * 8) + hex.slice(7);
    };
    const box = (r) => {
      const err = (size) => 2 + size * 0.02;
      return {
        x: jitter(r.left * dpr, err(r.width * dpr)),
        y: jitter(r.top * dpr, err(r.height * dpr)),
        w: Math.max(1, jitter(r.width * dpr, err(r.width * dpr))),
        h: Math.max(1, jitter(r.height * dpr, err(r.height * dpr))),
      };
    };
    const base = () => ({ fill: null, gradient: null, stroke: null, strokeWidth: null, radius: null, shadow: null, opacity: null, layout: "none", text: null, svg: null });

    const nodes = [];
    let n = 0;
    const id = () => `n${++n}`;

    function shadowOf(cs) {
      if (cs.boxShadow === "none") return null;
      const m = cs.boxShadow.match(/(rgba?\([^)]+\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px(?:\s+(-?[\d.]+)px)?/);
      if (!m) return null;
      return { color: parseColor(m[1]), x: +m[2] * dpr, y: +m[3] * dpr, blur: +m[4] * dpr, spread: (+m[5] || 0) * dpr };
    }
    function gradientOf(cs) {
      // Chrome omits the default "180deg" from computed gradients.
      const m = cs.backgroundImage.match(/linear-gradient\((?:(\d+)deg,\s*)?(.+)\)$/);
      if (!m) return null;
      const stops = [...m[2].matchAll(/(rgba?\([^)]+\))\s+([\d.]+)%/g)].map((x) => ({ color: noisyColor(parseColor(x[1])), position: +x[2] / 100 }));
      return stops.length >= 2 ? { angle: m[1] ? +m[1] : 180, stops } : null;
    }

    function walk(el, parent) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return;
      const r = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      const radius = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, r.width / 2, r.height / 2) * dpr || null;

      if (tag === "canvas") {
        nodes.push({ ...base(), id: id(), parent, type: "image", name: el.className ? `Image / ${el.className}` : "Photo", ...box(r), radius });
        return;
      }
      if (tag === "svg") {
        nodes.push({ ...base(), id: id(), parent, type: "icon", name: "Icon", ...box(r) });
        return;
      }

      const fill = parseColor(cs.backgroundColor);
      const gradient = gradientOf(cs);
      const bw = ["Top", "Right", "Bottom", "Left"].map((s) => parseFloat(cs[`border${s}Width`]) || 0);
      const allBorders = bw.every((w) => w > 0 && w === bw[0]);
      const shadow = shadowOf(cs);
      const elementChildren = [...el.children].filter((c) => getComputedStyle(c).display !== "none");
      const ownText = elementChildren.length === 0 ? el.textContent.trim() : "";

      let me = parent;
      const hasBox = fill || gradient || allBorders || shadow;
      if (el !== document.body && (hasBox || elementChildren.length >= 2 || (bw.some((w) => w > 0)))) {
        me = id();
        const flex = cs.display.includes("flex");
        nodes.push({
          ...base(),
          id: me,
          parent,
          type: "frame",
          name: el.className || tag,
          ...box(r),
          fill: noisyColor(fill),
          gradient,
          stroke: allBorders ? noisyColor(parseColor(cs.borderTopColor)) : null,
          strokeWidth: allBorders ? bw[0] * dpr : null,
          radius,
          shadow,
          layout: flex ? (cs.flexDirection.startsWith("column") ? "column" : "row") : elementChildren.length >= 2 ? "column" : "none",
        });
        // Partial borders become divider lines.
        if (!allBorders && bw[2] > 0) {
          nodes.push({ ...base(), id: id(), parent: me, type: "line", name: "Divider", x: r.left * dpr, y: (r.bottom - bw[2]) * dpr, w: r.width * dpr, h: bw[2] * dpr, fill: noisyColor(parseColor(cs.borderBottomColor)) });
        }
        if (!allBorders && bw[0] > 0) {
          nodes.push({ ...base(), id: id(), parent: me, type: "line", name: "Divider", x: r.left * dpr, y: r.top * dpr, w: r.width * dpr, h: bw[0] * dpr, fill: noisyColor(parseColor(cs.borderTopColor)) });
        }
        if (!allBorders && bw[1] > 0) {
          nodes.push({ ...base(), id: id(), parent: me, type: "line", name: "Divider", x: (r.right - bw[1]) * dpr, y: r.top * dpr, w: bw[1] * dpr, h: r.height * dpr, fill: noisyColor(parseColor(cs.borderRightColor)) });
        }
      }

      if (ownText) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const tr = range.getBoundingClientRect();
        const fontSize = parseFloat(cs.fontSize) * dpr;
        const lh = cs.lineHeight === "normal" ? null : parseFloat(cs.lineHeight) * dpr;
        nodes.push({
          ...base(),
          id: id(),
          parent: me,
          type: "text",
          name: ownText.slice(0, 30),
          ...box(tr),
          text: {
            content: ownText,
            fontFamily: cs.fontFamily.split(",")[0].replace(/["']/g, "").trim(),
            fontWeight: +cs.fontWeight,
            fontSize: fontSize * (1 + rnd() * 0.06),
            lineHeight: lh,
            letterSpacing: cs.letterSpacing === "normal" ? null : parseFloat(cs.letterSpacing) * dpr,
            color: noisyColor(parseColor(cs.color)),
            align: cs.textAlign === "center" ? "center" : cs.textAlign === "right" ? "right" : "left",
            italic: cs.fontStyle === "italic",
            decoration: "none",
          },
        });
        return;
      }
      for (const c of elementChildren) walk(c, me);
    }
    walk(document.body, "root");
    return { screenName: document.title || "Screen", background: parseColor(getComputedStyle(document.body).backgroundColor) ?? "#FFFFFF", nodes };
  }, { dpr: f.dpr, seed: 12345, noise: Number(process.env.NOISE ?? 1) });

  analysis.screenName = f.name[0].toUpperCase() + f.name.slice(1);
  await writeFile(join(out, `${f.name}${process.env.NOISE === "0" ? "-ideal" : ""}.model.json`), JSON.stringify({ ...analysis, pixelRatio: f.dpr }, null, 1));
  console.log(`${f.name}: ${analysis.nodes.length} nodes`);
  await page.close();
}
await browser.close();
