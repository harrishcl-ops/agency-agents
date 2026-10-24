// POST staged files to Figma upload URLs (same order as uploads.json).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [dir, ...urls] = process.argv.slice(2);
const uploads = JSON.parse(readFileSync(`${dir}/uploads.json`, "utf8"));
if (urls.length !== uploads.length) throw new Error(`need ${uploads.length} urls, got ${urls.length}`);
uploads.forEach((u, i) => {
  const res = execFileSync("curl", ["-sS", "-m", "120", "-X", "POST", "-F", `file=@${u.file};type=${u.type}`, urls[i]], { encoding: "utf8" });
  const r = JSON.parse(res);
  console.log(`${u.file.split("/").pop()}: ${r.success ? "ok" : "FAIL"} ${r.imageHash ?? res} node ${r.placedOnNodeId ?? "-"}`);
});
