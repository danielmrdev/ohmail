import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, req } from "./helpers.js";

/**
 * `/health` publishes the database transport, both hops, on every branch: `dbTls` (this host's
 * hop, from its own verified handshakes) and `dbTlsBackend` (`pg_stat_ssl`, the pooler's hop behind
 * a pooler). The operator's provider-side enforcement waits on `dbTls: true` read twice, so the key
 * must exist wherever the host injects it — and never 503 or darken the host when it faults.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null });

describe("GET /health — dbTls", () => {
  it("publishes both hops on the healthy branch, and asks for the backend once the probe reached it", async () => {
    const { deps } = await makeDeps();
    const asked: boolean[] = [];
    const res = await H(req("GET", "/health"), {
      ...deps,
      health: { version: "v", dbTls: async (reached) => { asked.push(reached); return { dbTls: true, dbTlsBackend: false }; } },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dbTls).toBe(true);
    expect(body.dbTlsBackend).toBe(false);
    expect(asked).toEqual([true]);
  });

  it("publishes the client hop on the unreachable branch without asking the backend", async () => {
    const { deps } = await makeDeps();
    const asked: boolean[] = [];
    const broken = {
      ...deps,
      db: { ...deps.db, execute: async () => { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); } } as unknown as ApiDeps["db"],
      health: { version: "v", dbTls: async (reached: boolean) => { asked.push(reached); return { dbTls: false, dbTlsBackend: null }; } },
    };
    const res = await H(req("GET", "/health"), broken);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.dbTls).toBe(false);
    expect(body.dbTlsBackend).toBeNull();
    expect(asked).toEqual([false]);
  });

  it("a faulting reading is no reading: no keys, and the verdict is untouched", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/health"), {
      ...deps, health: { version: "v", dbTls: async () => { throw new Error("boom"); } },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect("dbTls" in body).toBe(false);
    expect("dbTlsBackend" in body).toBe(false);
  });
});
