import Anthropic from "@anthropic-ai/sdk";
import { ANALYSIS_SCHEMA, CORRECTION_SCHEMA } from "./schema";
import {
  CORRECTION_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  buildCorrectionPrompt,
  buildUserPrompt,
} from "./prompt";
import { sanitizeAnalysis } from "./tree";
import type { Analysis, FlatNode, IconMode, ModelImage, ModelOptions, Platform } from "./types";

export const DEFAULT_MODEL = "claude-opus-5-5";

export const MODELS: { id: string; label: string; maxEdge: number }[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (best quality)", maxEdge: 2576 },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster, cheaper)", maxEdge: 2576 },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest)", maxEdge: 1568 },
];

/** Longest image edge the model reads at full resolution. */
export function maxEdgeFor(model: string): number {
  return MODELS.find((m) => m.id === model)?.maxEdge ?? 1568;
}

export type AnalysisErrorKind = "refusal" | "too_many_elements" | "invalid_response";

export class AnalysisError extends Error {
  constructor(
    message: string,
    readonly kind: AnalysisErrorKind,
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}

export interface AnalyzeRequest {
  image: ModelImage;
  platform: Platform;
  iconMode: IconMode;
  part?: { index: number; count: number };
  section?: { name: string; background: string | null };
}

export interface CorrectionRequest {
  original: ModelImage;
  rendered: ModelImage;
  mask: ModelImage;
  /** Nodes in region pixel space (same space as the images). */
  nodes: FlatNode[];
  mismatch: number;
  iconMode: IconMode;
}

export interface Correction {
  updates: unknown[];
  additions: unknown[];
  deletions: string[];
}

const imageBlock = (img: ModelImage): Anthropic.Beta.BetaImageBlockParam => ({
  type: "image",
  source: { type: "base64", media_type: img.mediaType, data: img.base64 },
});

/** Count `"parent"` keys as they stream, robust to keys split across deltas. */
function progressCounter(onProgress: (n: number) => void) {
  const count = (s: string) => s.split('"parent"').length - 1;
  let seen = 0;
  let tail = "";
  return (delta: string) => {
    const window = tail + delta;
    const hits = count(window) - count(tail);
    tail = window.slice(-16);
    if (hits > 0) {
      seen += hits;
      onProgress(seen);
    }
  };
}

/** One structured-output call; returns parsed JSON. */
async function callModel(
  client: Anthropic,
  model: ModelOptions,
  system: string,
  content: Anthropic.Beta.BetaContentBlockParam[],
  schema: Record<string, unknown>,
  onProgress?: (nodesSoFar: number) => void,
): Promise<unknown> {
  // Haiku has no server-side refusal fallback; the other models opt in.
  const fallback = model.model.startsWith("claude-haiku")
    ? {}
    : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

  const stream = client.beta.messages.stream({
    model: model.model,
    max_tokens: 64000,
    ...fallback,
    output_config: { effort: model.effort, format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content }],
  });
  if (onProgress) stream.on("text", progressCounter(onProgress));

  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new AnalysisError("Claude declined to analyse this image.", "refusal");
  }
  if (message.stop_reason === "max_tokens") {
    throw new AnalysisError("The image has too many elements for one pass.", "too_many_elements");
  }
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new AnalysisError("Claude returned a response that is not valid JSON.", "invalid_response");
  }
}

/**
 * Ask Claude to describe one screenshot (or a slice/section of one).
 * Coordinates in the result are pixels of `request.image`.
 */
export async function analyzeImage(
  client: Anthropic,
  request: AnalyzeRequest,
  model: ModelOptions,
  onProgress?: (nodesSoFar: number) => void,
): Promise<Analysis> {
  const parsed = await callModel(
    client,
    model,
    SYSTEM_PROMPT,
    [
      imageBlock(request.image),
      {
        type: "text",
        text: buildUserPrompt({
          width: request.image.width,
          height: request.image.height,
          platform: request.platform,
          iconMode: request.iconMode,
          part: request.part,
          section: request.section,
        }),
      },
    ],
    ANALYSIS_SCHEMA,
    onProgress,
  );
  return sanitizeAnalysis(parsed, request.image.width, request.image.height);
}

/** Ask Claude to correct the layers of one region given original/render/diff images. */
export async function correctRegion(
  client: Anthropic,
  request: CorrectionRequest,
  model: ModelOptions,
): Promise<Correction> {
  const parsed = (await callModel(
    client,
    model,
    CORRECTION_SYSTEM_PROMPT,
    [
      { type: "text", text: "Original:" },
      imageBlock(request.original),
      { type: "text", text: "Current Figma rendering:" },
      imageBlock(request.rendered),
      { type: "text", text: "Difference mask:" },
      imageBlock(request.mask),
      {
        type: "text",
        text: buildCorrectionPrompt({
          width: request.original.width,
          height: request.original.height,
          nodesJson: JSON.stringify(request.nodes),
          mismatchPercent: request.mismatch * 100,
          iconMode: request.iconMode,
        }),
      },
    ],
    CORRECTION_SCHEMA,
  )) as Partial<Correction> | null;
  return {
    updates: Array.isArray(parsed?.updates) ? parsed!.updates : [],
    additions: Array.isArray(parsed?.additions) ? parsed!.additions : [],
    deletions: Array.isArray(parsed?.deletions) ? parsed!.deletions.filter((d) => typeof d === "string") : [],
  };
}
