// Wraps arbitrary bytes in a valid 1x1 PNG (private "s2Fd" chunk) so test
// payloads can travel through Figma's image upload and be read back with
// figma.getImageByHash(hash).getBytesAsync().
import { readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
const [input, output] = process.argv.slice(2);
const payload = input === "-" ? Buffer.from(process.argv[4] ?? "") : readFileSync(input);
const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const idat = deflateSync(Buffer.from([0, 255, 0, 255, 255]));
writeFileSync(output, Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr), chunk("s2Fd", payload), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
]));
console.log(`${output}: ${payload.length} bytes`);
