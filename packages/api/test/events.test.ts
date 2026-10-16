import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps, type SseConfig } from "@trafficflow/api";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
// Reset the per-request mutable fields AND inject tiny SSE durations for determinism.
const H = (r: Request, d: ApiDeps, sse?: SseConfig): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null, ...(sse ? { sse } : {}) });

/** Drain a self-closing SSE stream to a string. */
async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text;
}

describe("GET /events (bounded SSE)", () => {
  it("emits a heartbeat + a sync frame for a mid-stream change, then server-closes by the lifetime; a concurrent write proceeds", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const sse: SseConfig = { heartbeatMs: 15, pollMs: 10, lifetimeMs: 200 };

    const res = await H(req("GET", "/events", { bearer: s.token }), deps, sse);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");

    // Mid-stream: create a rule over HTTP. If the SSE poll held a DB connection/tx open
    // (violating), this write would block on PGlite's single connection. It doesn't.
    let writeStatus = 0;
    setTimeout(() => {
      void H(req("POST", "/rules", { bearer: s.token, body: JSON.stringify({ kind: "sender", match: "x@y.example", destination: "INBOX" }) }), deps)
        .then((r) => { writeStatus = r.status; });
    }, 40);

    const text = await drain(res);   // returns only once the stream server-closes (lifetime)

    expect(text).toContain("event: ping\ndata: {}\n\n");   // heartbeat, a named frame
    expect(text).toContain("event: sync");   // wake frame
    expect(text).toMatch(/data: \{"seq":\d+\}/);  // carries the advancing seq
    expect(writeStatus).toBe(201);           // the concurrent write completed while /events was open
  });

  it("requires a session (401)", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/events"), deps, { heartbeatMs: 15, pollMs: 10, lifetimeMs: 50 });
    expect(res.status).toBe(401);
  });
});
