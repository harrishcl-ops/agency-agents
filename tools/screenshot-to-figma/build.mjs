// Builds dist/code.js (plugin main), dist/ui.html (UI with inlined script) and dist/server.js.
import { build, context } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");
await mkdir("dist", { recursive: true });

const common = { bundle: true, logLevel: "info", sourcemap: false, legalComments: "none" };

const targets = [
  { ...common, entryPoints: ["src/plugin/code.ts"], outfile: "dist/code.js", target: "es2017", format: "iife" },
  { ...common, entryPoints: ["src/ui/ui.ts"], outfile: "dist/ui.js", target: "es2020", format: "iife", minify: true },
  { ...common, entryPoints: ["src/server/server.ts"], outfile: "dist/server.js", platform: "node", target: "node20", format: "esm", packages: "external" },
];

async function inlineUi() {
  const html = await readFile("src/ui/ui.html", "utf8");
  // Escape "</script" so the inlined bundle can't close the tag early.
  const js = (await readFile("dist/ui.js", "utf8")).replace(/<\/script/gi, "<\\/script");
  await writeFile("dist/ui.html", html.replace("/*__UI_SCRIPT__*/", () => js));
}

if (watch) {
  for (const t of targets) {
    const ctx = await context({
      ...t,
      plugins: t.outfile === "dist/ui.js" ? [{ name: "inline", setup: (b) => b.onEnd(() => inlineUi()) }] : [],
    });
    await ctx.watch();
  }
} else {
  await Promise.all(targets.map((t) => build(t)));
  await inlineUi();
}
