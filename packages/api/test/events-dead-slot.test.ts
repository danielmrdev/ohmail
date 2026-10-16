import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, apiRoutes, type ApiDeps, type SseConfig } from "@trafficflow/api";
import { writeWebResponse } from "@trafficflow/core/adapters/http-host";
import { resetSseCounters, sseLiveCounts } from "../src/routes/events.js";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * THE CAP COUNTS LIVE STREAMS. A stream whose frames stop being taken holds its per-account slot
 * only for two heartbeats (the client's own silence bound), not for the whole lifetime: a tab on a
 * changing network leaves dead streams behind, and before this they filled the cap of four and the
 * next live tab was refused for minutes.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps, sse: SseConfig): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null, sse });

const HB = 40;
const BOUND = 2 * HB;
/** Lifetime far beyond the test, so only the delivery bound can free a slot. */
const CFG: SseConfig = { heartbeatMs: HB, pollMs: 60_000, lifetimeMs: 60_000, maxPerAccount: 4 };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const servers: Server[] = [];
const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];

afterEach(async () => {
  await Promise.all(readers.splice(0).map((r) => r.cancel().catch(() => {})));
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  resetSseCounters();
});

/** Read until the ready frame, then either keep reading (a live tab) or stop (a dead one). */
async function openTab(res: Response, live: boolean): Promise<{ pings: () => number }> {
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  readers.push(reader);
  const dec = new TextDecoder();
  let text = "";
  while (!text.includes("event: ready")) {
    const { done, value } = await reader.read();
    if (done) throw new Error("the stream ended before ready");
    text += dec.decode(value, { stream: true });
  }
  if (live) {
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) return;
        text += dec.decode(value, { stream: true });
      }
    })();
  }
  return { pings: () => text.split("event: ping").length - 1 };
}

const countFor = (accountId: string): number => sseLiveCounts().byAccount[accountId] ?? 0;

describe("GET /events frees the slot of a stream nobody reads", () => {
  it("a stream whose frames stop being taken releases its slot within two heartbeats", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await openTab(await H(req("GET", "/events", { bearer: s.token }), deps, CFG), false);
    expect(countFor(s.accountId)).toBe(1);
    await sleep(BOUND + 3 * HB);
    expect(countFor(s.accountId), "a dead stream still holds its slot").toBe(0);
  });

  it("the cap admits a fifth tab once a dead one is reaped", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const open = () => H(req("GET", "/events", { bearer: s.token }), deps, CFG);
    for (let i = 0; i < 3; i++) await openTab(await open(), true);
    await openTab(await open(), false);
    const refused = await open();
    expect(refused.status, "the premise: four streams fill the cap").toBe(429);
    await sleep(BOUND + 3 * HB);
    const fifth = await open();
    expect(fifth.status, "a dead stream kept the fifth tab out").toBe(200);
    await openTab(fifth, true);
    expect(countFor(s.accountId)).toBe(4);
  });

  it("CONTROL: four live tabs keep their slots past the bound, and the fifth is still refused", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const open = () => H(req("GET", "/events", { bearer: s.token }), deps, CFG);
    const tabs = [];
    for (let i = 0; i < 4; i++) tabs.push(await openTab(await open(), true));
    await sleep(BOUND + 4 * HB);
    expect(countFor(s.accountId)).toBe(4);
    expect(tabs.every((t) => t.pings() >= 2), "the live tabs were heard pinging").toBe(true);
    const fifth = await open();
    expect(fifth.status).toBe(429);
    expect((await fifth.json()).error.code).toBe("sse_too_many_streams");
  });

  it("CONTROL: a client that goes away through the self-host adapter frees its slot at once", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const slow: SseConfig = { ...CFG, heartbeatMs: 60_000 };
    const server = createServer((_in, out) => {
      void (async () => writeWebResponse(out, await H(req("GET", "/events", { bearer: s.token }), deps, slow)))();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const r = httpRequest({ host: "127.0.0.1", port, path: "/events" }, (res) => {
        res.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("event: ready")) { res.destroy(); resolve(); }
        });
      });
      r.on("error", (e) => { if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e); });
      r.end();
    });
    const until = Date.now() + 2_000;
    while (countFor(s.accountId) > 0 && Date.now() < until) await sleep(10);
    expect(countFor(s.accountId), "the closed socket's slot was not released").toBe(0);
  });
});
