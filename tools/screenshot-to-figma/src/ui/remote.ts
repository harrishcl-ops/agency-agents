// Client for the optional Screen2Figma server (keeps the Anthropic key off
// designers' machines). The server streams NDJSON: progress lines, then one
// result or error line.

import { AnalysisError, type AnalysisErrorKind } from "../shared/analyze";

export interface RemoteConfig {
  url: string;
  token: string;
}

export async function postNdjson<T>(
  config: RemoteConfig,
  path: string,
  body: unknown,
  onProgress?: (nodes: number) => void,
): Promise<T> {
  const res = await fetch(config.url.replace(/\/+$/, "") + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Server error ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as
        | { type: "progress"; nodes: number }
        | { type: "result"; data: T }
        | { type: "error"; message: string; kind?: AnalysisErrorKind };
      if (msg.type === "progress") onProgress?.(msg.nodes);
      else if (msg.type === "result") return msg.data;
      else if (msg.kind) throw new AnalysisError(msg.message, msg.kind);
      else throw new Error(msg.message);
    }
    if (done) break;
  }
  throw new Error("The server closed the connection without a result.");
}
