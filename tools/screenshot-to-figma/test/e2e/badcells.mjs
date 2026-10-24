// List bad-cell clusters (12px cells where most pixels mismatch) of a mask.
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
const m = PNG.sync.read(readFileSync(process.argv[2]));
const C = 12, cols = Math.ceil(m.width / C), rows = Math.ceil(m.height / C);
const bad = [];
for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
  let n = 0, t = 0;
  for (let y = cy * C; y < Math.min(m.height, cy * C + C); y++) for (let x = cx * C; x < Math.min(m.width, cx * C + C); x++) {
    const i = (y * m.width + x) * 4; t++; if (m.data[i] === 255 && m.data[i + 1] === 0) n++;
  }
  if (n > t / 2) bad.push([cx * C, cy * C]);
}
console.log(bad.map(([x, y]) => `${x},${y}`).join("  ") || "none");
