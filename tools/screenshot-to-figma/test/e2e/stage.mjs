// Stage a prepared payload for Figma: writes each image as a file, computes its
// Figma image hash (SHA-1 of the bytes), and packs {tree, image hashes,
// renderer bundle} into an ASCII-only carrier PNG. Prints the upload list.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [name, variant = ""] = process.argv.slice(2);
const out = "test/e2e/out";
const dir = join(out, `${name}${variant}.stage`);
mkdirSync(dir, { recursive: true });
const payload = JSON.parse(readFileSync(join(out, `${name}${variant}.payload.json`), "utf8"));
const sha1 = (b) => createHash("sha1").update(b).digest("hex");

const uploads = [];
const hashes = {};
for (const [id, b64] of Object.entries(payload.images)) {
  const bytes = Buffer.from(b64, "base64");
  const isPng = bytes[0] === 0x89;
  const file = join(dir, `s2f-${id}.${isPng ? "png" : "jpg"}`);
  writeFileSync(file, bytes);
  hashes[id] = sha1(bytes);
  uploads.push({ file, type: isPng ? "image/png" : "image/jpeg" });
}
const renderer = readFileSync(join(out, "renderer.min.js"), "utf8");
const json = JSON.stringify({ tree: payload.tree, images: hashes, pixelRatio: payload.pixelRatio, renderer })
  .replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
writeFileSync(join(dir, "payload.json"), json);
const carrier = join(dir, "s2f-carrier.png");
execFileSync("node", ["test/e2e/carrier.mjs", join(dir, "payload.json"), carrier]);
uploads.push({ file: carrier, type: "image/png" });
writeFileSync(join(dir, "uploads.json"), JSON.stringify(uploads));
console.log(JSON.stringify({ count: uploads.length, carrier: sha1(readFileSync(carrier)), dir }));
