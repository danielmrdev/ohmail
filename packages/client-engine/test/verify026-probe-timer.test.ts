import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAdapter, OhmailEngine } from "../src/index.js";
import { ORGANIZER_REQUESTS_REREAD_MS } from "../src/engine.js";

// VERIFY-026 HIGH 3, the verifier's probe kept as the control and INVERTED: the engine owns no
// timer, so an engine a surface dropped (sign-out revokes the gate; every read throws) reads
// nothing in an hour. Red at that change (120 reads); the re-read is the surface's cadence's poll.
const NOW = new Date("2026-10-02T09:00:00.000Z");
const RULE = {
  id: "r1", kind: "sender", match: "ann@shop.example", destination: "ohmail/News", priority: 0,
  provenance: "manual", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
};
const KEY = { kind: "sender", match: "ann@shop.example", subjectContains: null, bodyContains: null };
afterEach(() => { vi.useRealTimers(); });

describe("VERIFY-026 probe: the waiting list's re-read timer", () => {
  it("an engine nobody drives reads nothing in an hour, whatever the last list said", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let refusing = false;
    let asks = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      let status = 200;
      let body: unknown = {};
      if (href.includes("/sync?")) {
        body = { changes: { creates: href.includes("since=0") ? [{ type: "rule", op: "create", id: "r1", seq: 10, updatedAt: RULE.updatedAt, entity: RULE }] : [], updates: [], moves: [], deletes: [] },
          cursor: "10", hasMore: false, serverTime: NOW.toISOString() };
      } else if (href.endsWith("/organizer-requests")) {
        asks++;
        if (refusing) throw new Error("ForeignSessionError: what waits on the organizer"); // the gate, before the wire
        body = { items: [{ id: "req-1", kind: "rule.delete", state: "sent", mailboxId: "mb1", holder: { name: "Laptop" },
          decidedAt: NOW.toISOString(), resolvedAt: null, refusedReason: null, target: { rule: KEY } }] };
      } else if (/\/rules\/r1$/.test(href) && method === "DELETE") {
        status = 202;
        body = { pending: true, travel: { appliedLocally: [], pending: [{ mailboxId: "mb1", requestId: "req-1", holder: { kind: "local", name: "Laptop", since: NOW.toISOString() } }], refused: [] } };
      }
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "https://api.test", fetch: fetchImpl }), now: () => NOW });
    await engine.start();
    await engine.mutate({ kind: "rule_delete", ruleId: "r1" });
    await vi.advanceTimersByTimeAsync(0);
    const before = asks;
    // The surface drops this engine (sign-out: the gate is revoked and refuses every read).
    refusing = true;
    await vi.advanceTimersByTimeAsync(ORGANIZER_REQUESTS_REREAD_MS * 120); // one hour
    const afterHour = asks - before;
    console.log("PROBE timer reads in one hour after the reads began to refuse:", afterHour);
    const stopper = Object.getOwnPropertyNames(Object.getPrototypeOf(engine)).filter((n) => /^(stop|dispose|close|destroy|shutdown|teardown)$/i.test(n));
    console.log("PROBE engine methods that could stop it:", JSON.stringify(stopper));
    expect(afterHour, "something in the engine kept reading for an engine nobody drives").toBe(0);
  });
});
