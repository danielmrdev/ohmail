import { describe, it, expect, vi, afterEach } from "vitest";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { makeOpenAdapter } from "../src/attachments-adapter.js";
import { apiRoutes } from "../src/routes/index.js";
import { matchRoute } from "../src/router.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * THE EXACT URLS `HttpAdapter` EMITS (`packages/client-engine/src/adapters/http-adapter.ts`).
 *
 * Kept as literals here, and asserted against the REAL route table below, because the failure this
 * slice exists to fix is not a broken route — it is a route with no caller. All six attachment
 * routes shipped contract-tested and unreachable. A client method whose path is off by a segment
 * reproduces exactly that: green suites either side of a 404. The twin of this list is asserted in
 * `packages/client-engine/test/attachments-engine.o18.test.ts`.
 */
const CLIENT_PATHS = [
  { method: "GET", path: "/messages/m1/attachments", cost: "read" },
  { method: "GET", path: "/attachments/a1", cost: "connection" },
  { method: "POST", path: "/messages/m1/attachments/download-all", cost: "connection" },
] as const;

describe("the client's URLs reach real routes", () => {
  it.each(CLIENT_PATHS)("$method $path resolves, with cost $cost", ({ method, path, cost }) => {
    const m = matchRoute(apiRoutes, method, path);
    expect(m.route, `${method} ${path} matched NO route — the client would 404`).toBeTruthy();
    expect(m.route!.cost).toBe(cost);
  });

  it("the byte routes are `raw` (octet-stream/zip on 200, JSON envelope on error)", () => {
    for (const p of ["/attachments/a1", "/messages/m1/attachments/download-all"]) {
      const m = matchRoute(apiRoutes, p.endsWith("download-all") ? "POST" : "GET", p);
      // The client branches on `res.ok` BEFORE calling `.blob()` precisely because of this.
      expect(m.route!.options?.raw, `${p} must be raw`).toBe(true);
    }
  });

  it("none of them is `anonymous` — attachment bytes are mail content", () => {
    for (const { method, path } of CLIENT_PATHS) {
      const m = matchRoute(apiRoutes, method, path);
      // `anonymous` selects ANONYMOUS_PIPELINE, which omits `withSession`. The admin surface's own
      // routes are anonymous+secret-gated; if an attachment route ever became anonymous it would
      // lose the session gate that is the only thing scoping it to one account.
      expect(m.route!.options?.anonymous ?? false, `${path} must stay session-gated`).toBe(false);
    }
  });
});

/**
 * Gap `makeOpenAdapter` must FORWARD `fetchPart`'s options.
 *
 * This seam had no test at all, and it is the one place where dropping an argument defeats the
 * whole single-fetch ceiling while every other suite stays green: the service's pre-flight still
 * fires on honest metadata, so a test corpus with truthful sizes would never notice that the only
 * code able to stop a lying 90 MB part never hears the number.
 */

const locator = { folder: "INBOX", ref: "1:7" } as const;

/**
 * Just enough of ApiDeps for the creds lookup + decrypt this function performs — plus, since that change,
 * the two statements of the per-mailbox connection counter (`acquireImapSlot` / `releaseImapSlot`).
 * The counter's own behaviour is asserted in `attachments-imap-cap.at2.test.ts` (per-instance) and
 * `packages/db/test/imap-admission.at2.pg.test.ts` (cross-process, real Postgres); here it only has
 * to admit, so that this file keeps testing the one thing it is about — that `fetchPart`'s options
 * survive the seam.
 */
function fakeDeps(): ApiDeps {
  const row = {
    transport: "imap",
    secretEnc: Buffer.from("enc"),
    keyVersion: 1,
    meta: { host: "imap.example.invalid", port: 993, secure: true, user: "u@example.invalid" },
  };
  return {
    db: {
      select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
      // `acquireImapSlot`: returns a post-increment count of 1, i.e. "admitted".
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({ returning: () => Promise.resolve([{ failures: 1 }]) }),
        }),
      }),
      // `releaseImapSlot`: accepted and discarded.
      update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    },
    keyProvider: { decrypt: async () => "secret-not-printed" },
    // The cap is an injected port now. Always-admit, because this file is about what `fetchPart`
    // options reach the ImapAdapter; the cap has its own file (`attachments-imap-cap.at2`),
    // which passes the REAL counter.
    services: { imapAdmission: { acquire: async () => true, release: async () => {} } },
  } as unknown as ApiDeps;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("makeOpenAdapter forwards fetchPart options", () => {
  it("passes `maxBytes` through to the ImapAdapter", async () => {
    vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
    const fetchPart = vi.spyOn(ImapAdapter.prototype, "fetchPart").mockResolvedValue({
      contentType: "application/pdf", filename: "x.pdf", body: new Uint8Array([1]),
    });

    const handle = await makeOpenAdapter(fakeDeps())("mailbox-1");
    await handle.fetchPart(locator, "2", { maxBytes: 1234 });

    expect(fetchPart).toHaveBeenCalledWith(locator, "2", { maxBytes: 1234 });
  });

  it("passes `undefined` through unchanged when no ceiling was given", async () => {
    vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
    const fetchPart = vi.spyOn(ImapAdapter.prototype, "fetchPart").mockResolvedValue({
      contentType: "application/pdf", filename: "x.pdf", body: new Uint8Array([1]),
    });

    const handle = await makeOpenAdapter(fakeDeps())("mailbox-1");
    await handle.fetchPart(locator, "2");

    // `downloadAll` reuses ONE connection across a mailbox's parts, so it must be able to opt out:
    // a mid-stream abort would desync every remaining fetch on that socket.
    expect(fetchPart).toHaveBeenCalledWith(locator, "2", undefined);
  });
});
