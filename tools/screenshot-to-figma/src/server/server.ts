// Optional Screen2Figma server. Holds the Anthropic API key so designers'
// plugins only need the server URL (and a shared token).
//
//   ANTHROPIC_API_KEY=... S2F_TOKEN=secret PORT=8787 node dist/server.js
//
// POST /v1/analyze  { request: AnalyzeRequest, model: ModelOptions }
// POST /v1/correct  { request: CorrectionRequest, model: ModelOptions }
// Responses are NDJSON: {"type":"progress","nodes":n}* then {"type":"result","data":...}
// or {"type":"error","message":...,"kind"?:...}.

import Anthropic from "@anthropic-ai/sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AnalysisError, MODELS, analyzeImage, correctRegion } from "../shared/analyze";
import type { ModelOptions } from "../shared/types";

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.S2F_TOKEN ?? "";
const MAX_BODY = 40 * 1024 * 1024;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const client = new Anthropic();

function cors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
  res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Request too large.");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function modelFrom(raw: unknown): ModelOptions {
  const m = (raw ?? {}) as Partial<ModelOptions>;
  const model = MODELS.some((x) => x.id === m.model) ? m.model! : MODELS[0].id;
  const effort = EFFORTS.includes(m.effort as (typeof EFFORTS)[number]) ? m.effort! : "high";
  return { model, effort };
}

const server = createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    return;
  }
  if (req.method !== "POST" || (req.url !== "/v1/analyze" && req.url !== "/v1/correct")) {
    res.writeHead(404).end("Not found");
    return;
  }
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401).end("Unauthorized");
    return;
  }

  let body: { request?: unknown; model?: unknown };
  try {
    body = (await readJson(req)) as typeof body;
  } catch (err) {
    res.writeHead(400).end(err instanceof Error ? err.message : "Bad request");
    return;
  }

  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
  const send = (msg: unknown) => res.write(JSON.stringify(msg) + "\n");
  // Keep proxies from closing long requests while the model works.
  const keepAlive = setInterval(() => res.write("\n"), 15_000);
  try {
    const model = modelFrom(body.model);
    const data =
      req.url === "/v1/analyze"
        ? await analyzeImage(client, body.request as Parameters<typeof analyzeImage>[1], model, (nodes) =>
            send({ type: "progress", nodes }),
          )
        : await correctRegion(client, body.request as Parameters<typeof correctRegion>[1], model);
    send({ type: "result", data });
  } catch (err) {
    console.error(err);
    if (err instanceof AnalysisError) send({ type: "error", message: err.message, kind: err.kind });
    else if (err instanceof Anthropic.AuthenticationError) send({ type: "error", message: "The server's Anthropic API key is invalid." });
    else if (err instanceof Anthropic.RateLimitError) send({ type: "error", message: "Rate limited by the Anthropic API. Try again shortly." });
    else if (err instanceof Anthropic.APIError) send({ type: "error", message: `Anthropic API error ${err.status}: ${err.message}` });
    else send({ type: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

server.requestTimeout = 0;
server.listen(PORT, () => console.log(`Screen2Figma server on http://localhost:${PORT}`));
