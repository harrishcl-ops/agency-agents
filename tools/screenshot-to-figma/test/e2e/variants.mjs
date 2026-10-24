// Derive harder inputs from captured fixtures: JPEG-compressed copies.
//   node test/e2e/variants.mjs <name> <quality>  ->  out/<name>-q<quality>.{png,model.json}
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
const [name, q] = process.argv.slice(2);
const out = "test/e2e/out";
const png = PNG.sync.read(readFileSync(`${out}/${name}.png`));
const decoded = jpeg.decode(jpeg.encode({ data: png.data, width: png.width, height: png.height }, Number(q)).data, { useTArray: true });
const res = new PNG({ width: png.width, height: png.height });
res.data = Buffer.from(decoded.data);
writeFileSync(`${out}/${name}-q${q}.png`, PNG.sync.write(res));
copyFileSync(`${out}/${name}.model.json`, `${out}/${name}-q${q}.model.json`);
console.log(`${name}-q${q}`);
