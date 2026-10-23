// Canvas-based image I/O for the plugin UI (runs in the browser iframe).

import type { Pixels } from "../shared/color";
import type { ModelImage, Rect } from "../shared/types";

/** API limit is 5 MB per image (base64); stay under it with margin. */
const MAX_BASE64 = 4_500_000;
/** Keep decoded images under ~60 MP to stay within canvas limits. */
const MAX_PIXELS = 60_000_000;

export class ImageInputError extends Error {}

const canvases = new WeakMap<Pixels, HTMLCanvasElement>();

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new ImageInputError("Canvas is not available.");
  return ctx;
}

/** A canvas holding `px` (cached). */
function canvasOf(px: Pixels): HTMLCanvasElement {
  let c = canvases.get(px);
  if (!c) {
    c = canvas(px.width, px.height);
    const copy = new Uint8ClampedArray(px.width * px.height * 4);
    copy.set(px.data.subarray(0, copy.length));
    const data = new ImageData(copy, px.width, px.height);
    ctx2d(c).putImageData(data, 0, 0);
    canvases.set(px, c);
  }
  return c;
}

function sniff(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (ascii(0, 3) === "GIF") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 2) === "BM") return "image/bmp";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return "image/heic";
    if (/^avi[fs]$/.test(brand)) return "image/avif";
  }
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
  const head = new TextDecoder().decode(bytes.slice(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

async function loadViaImgElement(blob: Blob, isSvg: boolean): Promise<{ source: CanvasImageSource; width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    let width = img.naturalWidth;
    let height = img.naturalHeight;
    if (isSvg && (!width || !height)) {
      width = 1440;
      height = 900;
    }
    // Rasterise SVGs crisply at 2x.
    if (isSvg) {
      width *= 2;
      height *= 2;
    }
    return { source: img, width, height };
  } finally {
    // Keep the URL alive until the image has been drawn by the caller.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** Decode any browser-supported image into RGBA pixels at native resolution. */
export async function decodeImage(bytes: Uint8Array, declaredType = ""): Promise<Pixels> {
  const type = sniff(bytes) ?? declaredType;
  if (type === "image/heic" || type === "image/heif") {
    throw new ImageInputError("HEIC/HEIF photos can't be decoded inside Figma. Export the image as PNG or JPEG and try again.");
  }
  if (type === "application/pdf") throw new ImageInputError("PDFs aren't supported. Export the page as PNG.");
  const blob = new Blob([bytes as BlobPart], { type: type || "application/octet-stream" });

  let source: CanvasImageSource;
  let width: number;
  let height: number;
  try {
    if (type === "image/svg+xml") throw new Error("svg");
    const bitmap = await createImageBitmap(blob);
    source = bitmap;
    width = bitmap.width;
    height = bitmap.height;
  } catch {
    try {
      ({ source, width, height } = await loadViaImgElement(blob, type === "image/svg+xml"));
    } catch {
      throw new ImageInputError("This file isn't an image Figma's browser can read. Use PNG, JPEG, WebP, GIF, BMP, AVIF or SVG.");
    }
  }
  if (!width || !height) throw new ImageInputError("The image is empty.");

  // Very large images: downscale to fit canvas limits.
  const s = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)));
  const c = canvas(width * s, height * s);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, c.width, c.height);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const px: Pixels = { data: data.data, width: c.width, height: c.height };
  canvases.set(px, c);
  return px;
}

/** Resize pixels to exactly w x h (used when a render export is off by a pixel). */
export function resizePixels(px: Pixels, w: number, h: number): Pixels {
  if (px.width === w && px.height === h) return px;
  const c = canvas(w, h);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvasOf(px), 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const out: Pixels = { data: data.data, width: w, height: h };
  canvases.set(out, c);
  return out;
}

async function toBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode image."))), type, quality),
  );
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Region of `px`, scaled, alpha flattened onto white, encoded for the model. */
export async function encodeForModel(px: Pixels, region: Rect, scale: number): Promise<ModelImage> {
  const w = Math.max(1, Math.round(region.w * scale));
  const h = Math.max(1, Math.round(region.h * scale));
  const c = canvas(w, h);
  const ctx = ctx2d(c);
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvasOf(px), region.x, region.y, region.w, region.h, 0, 0, w, h);

  let base64 = await blobToBase64(await toBlob(c, "image/png"));
  let mediaType: ModelImage["mediaType"] = "image/png";
  for (const q of [0.95, 0.9, 0.8, 0.7]) {
    if (base64.length <= MAX_BASE64) break;
    base64 = await blobToBase64(await toBlob(c, "image/jpeg", q));
    mediaType = "image/jpeg";
  }
  return { base64, mediaType, width: w, height: h };
}

/** PNG bytes of a region of the original at source resolution (transparency kept). */
export async function cropPng(px: Pixels, region: Rect): Promise<Uint8Array> {
  const x = Math.max(0, Math.floor(region.x));
  const y = Math.max(0, Math.floor(region.y));
  const w = Math.max(1, Math.min(px.width - x, Math.ceil(region.x + region.w) - x));
  const h = Math.max(1, Math.min(px.height - y, Math.ceil(region.y + region.h) - y));
  const s = Math.min(1, 4096 / Math.max(w, h));
  const c = canvas(w * s, h * s);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvasOf(px), x, y, w, h, 0, 0, c.width, c.height);
  return new Uint8Array(await (await toBlob(c, "image/png")).arrayBuffer());
}

/** Whole image as PNG (Figma's createImage accepts PNG/JPEG/GIF only). */
export async function toPng(px: Pixels): Promise<Uint8Array> {
  return cropPng(px, { x: 0, y: 0, w: px.width, h: px.height });
}
