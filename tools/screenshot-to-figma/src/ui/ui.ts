// Plugin UI: input handling, settings, model calls, and the conversion loop.

import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL, MODELS, analyzeImage, correctRegion, maxEdgeFor, type AnalyzeRequest, type Correction, type CorrectionRequest } from "../shared/analyze";
import type { Pixels } from "../shared/color";
import { CancelledError, Pipeline, type Host, type Quality } from "../shared/pipeline";
import { countNodes } from "../shared/tree";
import type { Analysis, DesignTree, IconMode, ModelOptions, Platform } from "../shared/types";
import type { RenderStats } from "../plugin/render";
import { ImageInputError, cropPng, decodeImage, encodeForModel, resizePixels, toPng } from "./imaging";
import { postNdjson } from "./remote";

interface Settings {
  mode: "direct" | "server";
  apiKey: string;
  serverUrl: string;
  serverToken: string;
  model: string;
  effort: ModelOptions["effort"];
  quality: Quality;
  maxRounds: number;
  platform: Platform;
  pixelRatio: number;
  iconMode: IconMode;
  autoLayout: boolean;
  addReference: boolean;
}

const DEFAULTS: Settings = {
  mode: "direct",
  apiKey: "",
  serverUrl: "",
  serverToken: "",
  model: DEFAULT_MODEL,
  effort: "high",
  quality: "pixel-perfect",
  maxRounds: 3,
  platform: "auto",
  pixelRatio: 0,
  iconMode: "vector",
  autoLayout: true,
  addReference: true,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  drop: $<HTMLDivElement>("drop"),
  dropHint: $<HTMLDivElement>("dropHint"),
  preview: $<HTMLImageElement>("preview"),
  file: $<HTMLInputElement>("file"),
  useSelection: $<HTMLButtonElement>("useSelection"),
  clear: $<HTMLButtonElement>("clear"),
  importS2f: $<HTMLButtonElement>("importS2f"),
  s2fFile: $<HTMLInputElement>("s2fFile"),
  quality: $<HTMLSelectElement>("quality"),
  platform: $<HTMLSelectElement>("platform"),
  pixelRatio: $<HTMLSelectElement>("pixelRatio"),
  iconMode: $<HTMLSelectElement>("iconMode"),
  autoLayout: $<HTMLInputElement>("autoLayout"),
  addReference: $<HTMLInputElement>("addReference"),
  settings: $<HTMLDetailsElement>("settings"),
  mode: $<HTMLSelectElement>("mode"),
  keyField: $<HTMLLabelElement>("keyField"),
  apiKey: $<HTMLInputElement>("apiKey"),
  serverFields: $<HTMLDivElement>("serverFields"),
  serverUrl: $<HTMLInputElement>("serverUrl"),
  serverToken: $<HTMLInputElement>("serverToken"),
  model: $<HTMLSelectElement>("model"),
  effort: $<HTMLSelectElement>("effort"),
  maxRounds: $<HTMLInputElement>("maxRounds"),
  convert: $<HTMLButtonElement>("convert"),
  cancel: $<HTMLButtonElement>("cancel"),
  bar: $<HTMLDivElement>("bar"),
  status: $<HTMLDivElement>("status"),
  result: $<HTMLDivElement>("result"),
  score: $<HTMLDivElement>("score"),
  resultDetail: $<HTMLDivElement>("resultDetail"),
};

for (const m of MODELS) el.model.add(new Option(m.label, m.id));

let settings: Settings = { ...DEFAULTS };
let source: { pixels: Pixels; name: string } | null = null;
let running = false;
let cancelled = false;

// ---------- messaging with the main thread ----------

const post = (msg: unknown) => parent.postMessage({ pluginMessage: msg }, "*");
let renderId = 0;
const pendingRenders = new Map<number, { resolve: (v: { png: Uint8Array; stats: RenderStats }) => void; reject: (e: Error) => void }>();

window.onmessage = async (event: MessageEvent) => {
  const msg = event.data?.pluginMessage;
  if (!msg) return;
  switch (msg.type) {
    case "settings":
      settings = { ...DEFAULTS, ...(msg.settings ?? {}) };
      writeForm();
      break;
    case "rendered": {
      const pending = pendingRenders.get(msg.id);
      pendingRenders.delete(msg.id);
      if (msg.error) pending?.reject(new Error(msg.error));
      else pending?.resolve({ png: msg.png, stats: msg.stats });
      break;
    }
    case "selection-image":
      if (msg.error) setStatus(msg.error, true);
      else await loadBytes(msg.bytes, "image/png", msg.name);
      break;
    case "error":
      setStatus(msg.message, true);
      break;
  }
};

// ---------- settings form ----------

function writeForm(): void {
  el.quality.value = settings.quality;
  el.platform.value = settings.platform;
  el.pixelRatio.value = String(settings.pixelRatio);
  el.iconMode.value = settings.iconMode;
  el.autoLayout.checked = settings.autoLayout;
  el.addReference.checked = settings.addReference;
  el.mode.value = settings.mode;
  el.apiKey.value = settings.apiKey;
  el.serverUrl.value = settings.serverUrl;
  el.serverToken.value = settings.serverToken;
  el.model.value = settings.model;
  el.effort.value = settings.effort;
  el.maxRounds.value = String(settings.maxRounds);
  syncMode();
  if (!configured()) el.settings.open = true;
  updateConvert();
}

function readForm(): void {
  settings = {
    quality: el.quality.value as Quality,
    platform: el.platform.value as Platform,
    pixelRatio: Number(el.pixelRatio.value),
    iconMode: el.iconMode.value as IconMode,
    autoLayout: el.autoLayout.checked,
    addReference: el.addReference.checked,
    mode: el.mode.value as Settings["mode"],
    apiKey: el.apiKey.value.trim(),
    serverUrl: el.serverUrl.value.trim(),
    serverToken: el.serverToken.value.trim(),
    model: el.model.value,
    effort: el.effort.value as Settings["effort"],
    maxRounds: Math.max(0, Math.min(8, Number(el.maxRounds.value) || 0)),
  };
  post({ type: "save-settings", settings });
  syncMode();
  updateConvert();
}

function syncMode(): void {
  el.keyField.hidden = settings.mode !== "direct";
  el.serverFields.hidden = settings.mode !== "server";
}

const configured = () => (settings.mode === "direct" ? settings.apiKey.length > 0 : settings.serverUrl.length > 0);

function updateConvert(): void {
  el.convert.disabled = running || !source || !configured();
  el.convert.title = !configured() ? "Add an API key or server URL under Connection & model" : "";
}

document.querySelectorAll("select, input").forEach((input) => {
  if (input !== el.file) input.addEventListener("change", readForm);
});

// ---------- input ----------

function setStatus(text: string, error = false, fraction?: number): void {
  el.status.textContent = text;
  el.status.classList.toggle("error", error);
  if (fraction !== undefined) el.bar.style.width = `${Math.round(fraction * 100)}%`;
}

async function loadBytes(bytes: Uint8Array, type: string, name: string): Promise<void> {
  try {
    setStatus("Reading image…");
    const pixels = await decodeImage(bytes, type);
    source = { pixels, name: name.replace(/\.[a-z0-9]+$/i, "") || "Screen" };
    const png = await toPng(pixels);
    el.preview.src = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
    el.preview.hidden = false;
    el.dropHint.hidden = true;
    el.clear.disabled = false;
    el.result.classList.remove("show");
    setStatus(`${pixels.width} × ${pixels.height}px ready`, false, 0);
  } catch (err) {
    source = null;
    setStatus(err instanceof ImageInputError ? err.message : `Couldn't read the image: ${String(err)}`, true);
  }
  updateConvert();
}

async function loadFile(file: File): Promise<void> {
  await loadBytes(new Uint8Array(await file.arrayBuffer()), file.type, file.name);
}

el.drop.addEventListener("click", () => el.file.click());
el.drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") el.file.click();
});
el.file.addEventListener("change", () => {
  const f = el.file.files?.[0];
  if (f) void loadFile(f);
  el.file.value = "";
});
el.drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  el.drop.classList.add("over");
});
el.drop.addEventListener("dragleave", () => el.drop.classList.remove("over"));
el.drop.addEventListener("drop", (e) => {
  e.preventDefault();
  el.drop.classList.remove("over");
  const f = Array.from(e.dataTransfer?.files ?? []).find((x) => x.type.startsWith("image/") || /\.(svg|avif|bmp|ico)$/i.test(x.name));
  if (f) void loadFile(f);
  else setStatus("Drop an image file.", true);
});
document.addEventListener("paste", (e) => {
  const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
  const f = item?.getAsFile();
  if (f) void loadFile(f);
});
el.useSelection.addEventListener("click", () => post({ type: "use-selection" }));
el.clear.addEventListener("click", () => {
  source = null;
  el.preview.hidden = true;
  el.dropHint.hidden = false;
  el.clear.disabled = true;
  el.result.classList.remove("show");
  setStatus("", false, 0);
  updateConvert();
});

// ---------- model access ----------

function modelOptions(): ModelOptions {
  return { model: settings.model, effort: settings.effort };
}

function anthropic(): Anthropic {
  return new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 4, timeout: 20 * 60 * 1000 });
}

async function analyze(request: AnalyzeRequest, onProgress?: (n: number) => void): Promise<Analysis> {
  if (settings.mode === "server") {
    return postNdjson<Analysis>({ url: settings.serverUrl, token: settings.serverToken }, "/v1/analyze", { request, model: modelOptions() }, onProgress);
  }
  return analyzeImage(anthropic(), request, modelOptions(), onProgress);
}

async function correct(request: CorrectionRequest): Promise<Correction> {
  if (settings.mode === "server") {
    return postNdjson<Correction>({ url: settings.serverUrl, token: settings.serverToken }, "/v1/correct", { request, model: modelOptions() });
  }
  return correctRegion(anthropic(), request, modelOptions());
}

function friendlyError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected. Check it under Connection & model.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key can't use the selected model.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API. Wait a minute and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API. Check your connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

// ---------- conversion ----------

async function convert(): Promise<void> {
  if (!source || running) return;
  readForm();
  running = true;
  cancelled = false;
  el.convert.hidden = true;
  el.cancel.hidden = false;
  el.result.classList.remove("show");
  updateConvert();

  const pixels = source.pixels;
  let lastStats: RenderStats | null = null;
  let didRender = false;
  let finished = false;
  const host: Host = {
    pixels,
    encode: encodeForModel,
    crop: (px, region) => cropPng(px, region),
    analyze,
    correct,
    async render(tree: DesignTree, images) {
      const id = ++renderId;
      const done = new Promise<{ png: Uint8Array; stats: RenderStats }>((resolve, reject) => pendingRenders.set(id, { resolve, reject }));
      post({
        type: "render",
        id,
        tree,
        images,
        pixelRatio: pixelRatioUsed,
        options: {
          autoLayout: settings.autoLayout,
          iconMode: settings.iconMode,
          // In design units: ~1 screenshot pixel for pixel-perfect, ~3 for fast.
          layoutTolerance: (settings.quality === "pixel-perfect" ? 1 : 3) / pixelRatioUsed,
          fitText: true,
        },
      });
      const { png, stats } = await done;
      lastStats = stats;
      didRender = true;
      const rendered = await decodeImage(png, "image/png");
      return resizePixels(rendered, pixels.width, pixels.height);
    },
    status: (message, fraction) => setStatus(message, false, fraction),
    cancelled: () => cancelled,
  };

  let pixelRatioUsed = settings.pixelRatio;
  const pipeline = new Pipeline(host, {
    platform: settings.platform,
    pixelRatio: settings.pixelRatio,
    autoLayout: settings.autoLayout,
    iconMode: settings.iconMode,
    addReference: settings.addReference,
    quality: settings.quality,
    maxRounds: settings.quality === "pixel-perfect" ? settings.maxRounds : 0,
    maxEdge: maxEdgeFor(settings.model),
    concurrency: 3,
  });
  pixelRatioUsed = pipeline.resolvePixelRatio();

  try {
    const result = await pipeline.run();
    post({ type: "finish", reference: settings.addReference ? await toPng(pixels) : null, name: result.tree.name });
    finished = true;
    const history = result.mismatchHistory;
    const stats = lastStats as RenderStats | null;
    el.result.classList.add("show");
    if (history.length > 0) {
      const first = (1 - history[0]) * 100;
      const best = (1 - Math.min(...history)) * 100;
      el.score.textContent = `${best.toFixed(1)}%`;
      el.resultDetail.textContent = `First render ${first.toFixed(1)}% → final ${best.toFixed(1)}% after ${history.length - 1} correction round(s). `;
    } else {
      el.score.textContent = "Done";
      el.resultDetail.textContent = "";
    }
    if (stats) {
      el.resultDetail.textContent += `${countNodes(result.tree.children)} layers, ${stats.autoLayoutFrames} auto-layout frames, ${stats.vectors} vectors, ${stats.images} images.`;
      if (stats.substitutedFonts.length) el.resultDetail.textContent += ` Fonts not installed (substituted): ${stats.substitutedFonts.join(", ")}.`;
    }
    setStatus("Done — the design is selected on the canvas.", false, 1);
    post({ type: "notify", message: "Screen2Figma: design created" });
  } catch (err) {
    if (err instanceof CancelledError) setStatus("Cancelled. The last rendered version stays on the canvas.", false, 0);
    else setStatus(friendlyError(err), true);
  } finally {
    // Keep whatever was rendered last on the canvas.
    if (didRender && !finished) post({ type: "finish", reference: null, name: source?.name ?? "Screen" });
    running = false;
    el.convert.hidden = false;
    el.cancel.hidden = true;
    updateConvert();
  }
}

el.convert.addEventListener("click", () => void convert());

// ---------- import a pre-converted design (.s2f.json) ----------

interface S2fFile {
  format: "screen2figma";
  version: 1;
  name: string;
  pixelRatio: number;
  tree: DesignTree;
  /** Node id -> base64 PNG/JPEG. */
  images: Record<string, string>;
  /** Optional original screenshot (base64 PNG/JPEG) to place beside the design. */
  reference?: string;
  options?: { autoLayout?: boolean; layoutTolerance?: number };
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function importS2f(file: File): Promise<void> {
  if (running) return;
  running = true;
  updateConvert();
  try {
    setStatus("Reading design file…", false, 0.2);
    const doc = JSON.parse(await file.text()) as S2fFile;
    if (doc.format !== "screen2figma" || !doc.tree) throw new Error("This isn't a Screen2Figma (.s2f.json) file.");
    const images: Record<string, Uint8Array> = {};
    for (const [id, b64] of Object.entries(doc.images ?? {})) images[id] = fromBase64(b64);
    setStatus("Building Figma layers…", false, 0.5);
    const id = ++renderId;
    const done = new Promise<{ png: Uint8Array; stats: RenderStats }>((resolve, reject) => pendingRenders.set(id, { resolve, reject }));
    post({
      type: "render",
      id,
      tree: doc.tree,
      images,
      pixelRatio: doc.pixelRatio || 1,
      options: {
        autoLayout: doc.options?.autoLayout ?? true,
        iconMode: "image",
        layoutTolerance: doc.options?.layoutTolerance ?? 1 / (doc.pixelRatio || 1),
        fitText: true,
      },
    });
    const { stats } = await done;
    post({ type: "finish", reference: doc.reference && settings.addReference ? fromBase64(doc.reference) : null, name: doc.name || doc.tree.name });
    setStatus(`Imported "${doc.name || doc.tree.name}": ${stats.layers} layers, ${stats.autoLayoutFrames} auto-layout frames, ${stats.vectors} vectors, ${stats.images} images.`, false, 1);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  } finally {
    running = false;
    updateConvert();
  }
}

el.importS2f.addEventListener("click", () => el.s2fFile.click());
el.s2fFile.addEventListener("change", () => {
  const f = el.s2fFile.files?.[0];
  if (f) void importS2f(f);
  el.s2fFile.value = "";
});
el.cancel.addEventListener("click", () => {
  cancelled = true;
  setStatus("Cancelling after the current step…");
});

post({ type: "load-settings" });
