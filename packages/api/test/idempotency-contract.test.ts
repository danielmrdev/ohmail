import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import { idempotencyKeys, pruneIdempotencyKeys, claimIdempotencyKey, readIdempotencyKey, type Tx } from "@trafficflow/db";
import { canonicalQuery } from "../src/middleware.js";
import { createApp, jsonResponse, recordIdempotent, type Route } from "@trafficflow/api";
import { IdempotencyRaceLost } from "@trafficflow/services";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * The rest of the persisted idempotency contract: the QUERY STRING is inside the hash, and
 * `expires_at` is enforced rather than merely written.
 */

/** A minimal idempotent route that stores whatever body it was given. */
function echoRoute(): { route: Route; calls: () => number } {
  let calls = 0;
  const route: Route = {
    method: "POST",
    pattern: "/echo",
    options: { idempotent: true },
    handler: async (request, deps) => {
      calls++;
      const accountId = deps.session!.accountId;
      const idem = deps.idempotency;
      const payload = { n: calls, url: new URL(request.url).search };
      if (idem) {
        const claimed = await (deps.db as unknown as Tx).transaction(async (tx) => recordIdempotent(tx, {
          accountId, key: idem.key, requestHash: idem.requestHash,
          responseStatus: 200, seq: null, responseJson: payload, now: deps.now(),
        }));
        if (!claimed) throw new IdempotencyRaceLost(accountId, idem.key);
      }
      return jsonResponse(payload, { status: 200 });
    },
  };
  return { route, calls: () => calls };
}

describe("the request hash covers the QUERY STRING", () => {
  it("canonicalQuery sorts, so parameter ORDER is not a different request", () => {
    const q = (u: string): string => canonicalQuery(new URL(`http://h/x${u}`));
    expect(q("?b=2&a=1")).toBe(q("?a=1&b=2"));
    expect(q("")).toBe("");
    // Different VALUES are a different request; that distinction must survive sorting.
    expect(q("?a=1")).not.toBe(q("?a=2"));
    // Repeated keys keep both values, in a defined order.
    expect(q("?a=2&a=1")).toBe("a=1&a=2");
  });

  it("same key + same path but a DIFFERENT query → 409, not a replay of the other semantics", async () => {
    // The hash used to be method + path + body only, which silently asserted that no idempotent
    // route will ever read a query parameter. Nothing enforced that, and the first one to do so
    // would have replayed one request's response for a different request.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { route, calls } = echoRoute();
    const app = createApp([route]);
    const send = (qs: string): Promise<Response> => app.handle(
      req("POST", `/echo${qs}`, { bearer: s.token, headers: { "idempotency-key": "q1" }, body: "{}" }),
      { ...deps, idempotency: null, session: null },
    );

    expect((await send("?scope=one")).status).toBe(200);
    const clash = await send("?scope=two");
    expect(clash.status).toBe(409);
    expect((await clash.json()).error.code).toBe("idempotency_replay");
    expect(calls()).toBe(1);                      // the second request never reached the handler
  });

  it("the SAME query in a different ORDER replays instead of 409ing", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { route, calls } = echoRoute();
    const app = createApp([route]);
    const send = (qs: string): Promise<Response> => app.handle(
      req("POST", `/echo${qs}`, { bearer: s.token, headers: { "idempotency-key": "q2" }, body: "{}" }),
      { ...deps, idempotency: null, session: null },
    );

    const first = await send("?a=1&b=2");
    const second = await send("?b=2&a=1");
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(calls()).toBe(1);
  });
});

describe("expires_at is ENFORCED, not decorative", () => {
  it("a stored response past its TTL is not replayed — the mutation runs again", async () => {
    const { db, deps, clock } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, accessExpiresAt: new Date(FIXED_NOW.getTime() + 90 * 3600_000) });
    const { route, calls } = echoRoute();
    const app = createApp([route]);
    const send = (): Promise<Response> => app.handle(
      req("POST", "/echo", { bearer: s.token, headers: { "idempotency-key": "ttl" }, body: "{}" }),
      { ...deps, now: () => clock.now(), idempotency: null, session: null },
    );

    expect((await send()).status).toBe(200);
    expect(calls()).toBe(1);
    // Within the window: replay, handler not re-run.
    clock.advance(23 * 3600_000);
    expect((await send()).status).toBe(200);
    expect(calls()).toBe(1);
    // Past 24h: the key is a spent promise, so this is a NEW request.
    clock.advance(2 * 3600_000);
    expect((await send()).status).toBe(200);
    expect(calls()).toBe(2);
  });

  it("claimIdempotencyKey takes over an EXPIRED row instead of colliding with it forever", async () => {
    const { db } = await makeDeps();
    const accountId = crypto.randomUUID();
    const tx = db as unknown as Tx;
    const t0 = FIXED_NOW;

    expect(await claimIdempotencyKey(tx, {
      accountId, key: "k", requestHash: "h1", responseStatus: 200, responseJson: { v: 1 }, seq: null, now: t0,
    })).toBe(true);
    // A LIVE row belongs to whoever wrote it: the claim must fail.
    expect(await claimIdempotencyKey(tx, {
      accountId, key: "k", requestHash: "h2", responseStatus: 200, responseJson: { v: 2 }, seq: null, now: t0,
    })).toBe(false);
    expect((await readIdempotencyKey(tx, accountId, "k", t0))!.responseJson).toEqual({ v: 1 });

    // Past the TTL the row is dead weight; a new claim takes it over rather than 500ing forever.
    const later = new Date(t0.getTime() + 25 * 3600_000);
    expect(await claimIdempotencyKey(tx, {
      accountId, key: "k", requestHash: "h3", responseStatus: 201, responseJson: { v: 3 }, seq: null, now: later,
    })).toBe(true);
    const row = await readIdempotencyKey(tx, accountId, "k", later);
    expect(row).toMatchObject({ requestHash: "h3", responseStatus: 201, responseJson: { v: 3 } });
  });

  it("readIdempotencyKey treats an expired row as ABSENT", async () => {
    const { db } = await makeDeps();
    const accountId = crypto.randomUUID();
    const tx = db as unknown as Tx;
    await claimIdempotencyKey(tx, {
      accountId, key: "gone", requestHash: "h", responseStatus: 200, responseJson: {}, seq: null, now: FIXED_NOW,
    });
    expect(await readIdempotencyKey(tx, accountId, "gone", FIXED_NOW)).not.toBeNull();
    expect(await readIdempotencyKey(tx, accountId, "gone", new Date(FIXED_NOW.getTime() + 25 * 3600_000))).toBeNull();
  });

  it("pruneIdempotencyKeys deletes ONLY what has aged out (the worker's maintenance pass)", async () => {
    // Nothing ever revisits an idempotency row, so without a sweep the table only grows.
    const { db } = await makeDeps();
    const accountId = crypto.randomUUID();
    const tx = db as unknown as Tx;
    const old = FIXED_NOW;
    const fresh = new Date(FIXED_NOW.getTime() + 20 * 3600_000);
    await claimIdempotencyKey(tx, { accountId, key: "old", requestHash: "a", responseStatus: 200, responseJson: {}, seq: null, now: old });
    await claimIdempotencyKey(tx, { accountId, key: "new", requestHash: "b", responseStatus: 200, responseJson: {}, seq: null, now: fresh });

    const at = new Date(old.getTime() + 25 * 3600_000);      // old expired, new not yet
    expect(await pruneIdempotencyKeys(tx, at)).toBe(1);
    const left = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.accountId, accountId));
    expect(left.map((r) => r.key)).toEqual(["new"]);
    // Idempotent: a second sweep removes nothing.
    expect(await pruneIdempotencyKeys(tx, at)).toBe(0);
  });

  it("a replayed response still commits nothing new — the stored row is untouched by a replay", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { route } = echoRoute();
    const app = createApp([route]);
    const send = (): Promise<Response> => app.handle(
      req("POST", "/echo", { bearer: s.token, headers: { "idempotency-key": "once" }, body: "{}" }),
      { ...deps, idempotency: null, session: null },
    );
    await send();
    const before = await db.select().from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.accountId, s.accountId), eq(idempotencyKeys.key, "once")));
    await send();
    const after = await db.select().from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.accountId, s.accountId), eq(idempotencyKeys.key, "once")));
    expect(after).toEqual(before);
  });
});
