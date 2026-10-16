/**
 * An answered refusal on the stdio door is a log line (FIX-022). `request_failed` covers a handler
 * that threw; a handler answering 4xx/5xx wrote a frame and nothing else, so a window whose pull
 * was refused on every attempt left the engine log clean. A 404 stays silent — it is an optional
 * route being probed. The single-body read is a line whatever it answered (`body_read`).
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION } from "../src/frame.js";
import { serveOverStdio } from "../src/host.js";

type Line = { event: string; fields: Record<string, unknown> };

async function askOnce(status: number, url = "http://sidecar/sync?since=MQ"): Promise<{ lines: Line[]; answered: number }> {
  const lines: Line[] = [];
  const input = new PassThrough();
  const output = new PassThrough();
  const decoder = new FrameDecoder({});
  let answered = -1;
  output.on("data", (chunk: Buffer) => {
    for (const f of decoder.push(chunk)) {
      const h = f.header as { t?: string; status?: number };
      if (h.t === "res" && typeof h.status === "number") answered = h.status;
    }
  });
  const host = serveOverStdio({
    handle: async () => new Response(status === 204 ? null : JSON.stringify({ error: { code: "x", message: "y" } }), {
      status, headers: { "content-type": "application/json" },
    }),
    input, output,
    log: (event: string, fields?: Record<string, unknown>) => { lines.push({ event, fields: fields ?? {} }); },
  });
  input.write(encodeFrame({ v: PROTOCOL_VERSION, t: "req", id: 7, method: "GET", url, h: [] }));
  for (let i = 0; i < 50 && answered === -1; i++) await new Promise((r) => setTimeout(r, 5));
  host.stop();
  return { lines, answered };
}

describe("the stdio door logs an answered refusal", () => {
  it("a 410 on the window's /sync writes request_refused with status and route, never the query", async () => {
    const { lines, answered } = await askOnce(410);
    expect(answered).toBe(410);
    const refused = lines.filter((l) => l.event === "request_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.fields).toMatchObject({ requestId: 7, method: "GET", status: 410 });
    expect(String(refused[0]!.fields.route)).not.toContain("since=");
  });
  it("a 500 answered as an envelope is a line too", async () => {
    const { lines } = await askOnce(500);
    expect(lines.filter((l) => l.event === "request_refused").map((l) => l.fields.status)).toEqual([500]);
  });
  it("a 200 and a 404 write nothing", async () => {
    for (const status of [200, 404]) {
      const { lines, answered } = await askOnce(status);
      expect(answered).toBe(status);
      expect(lines.filter((l) => l.event === "request_refused"), `status ${status}`).toHaveLength(0);
      expect(lines.filter((l) => l.event === "body_read"), `status ${status}`).toHaveLength(0);
    }
  });
});

describe("every single-body read is a line", () => {
  const BODY = "http://sidecar/messages/0b6f1c2e-9d0a-4c1e-8f3a-2b7d5e4a9c10/body";
  it("200 and 404 on the body read each write body_read with the route's pattern, never the id", async () => {
    for (const status of [200, 404]) {
      const { lines, answered } = await askOnce(status, BODY);
      expect(answered).toBe(status);
      const read = lines.filter((l) => l.event === "body_read");
      expect(read, `status ${status}`).toHaveLength(1);
      expect(read[0]!.fields).toMatchObject({ requestId: 7, method: "GET", route: "/messages/:id/body", status });
      expect(typeof read[0]!.fields.latencyMs).toBe("number");
      expect(JSON.stringify(lines)).not.toContain("0b6f1c2e");
      expect(lines.filter((l) => l.event === "request_refused")).toHaveLength(0);
    }
  });
  it("a 500 there is a refusal as well as a read", async () => {
    const refused = await askOnce(500, BODY);
    expect(refused.lines.map((l) => l.event)).toEqual(["request_refused", "body_read"]);
  });
});
