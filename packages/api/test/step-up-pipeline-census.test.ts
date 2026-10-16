import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * **A `stepUp` FLAG ON A ROUTE WHOSE CHAIN CANNOT ENFORCE IT IS NOT A CONTROL.**
 *
 * This is the third time this exact shape has been found in this codebase, which is why the guard
 * is a census over the route table rather than a case for one route:
 *
 *  1. `verifiedEmail: true` was an opt-in flag, and `withVerifiedEmail` was only in
 *     FULL_PIPELINE — so setting it on the five costliest (raw) routes would have done nothing.
 *     Written up in `spend-gate.test.ts`.
 *  2. `withSpendGate` was likewise absent from RAW_PIPELINE, which `app.ts` records.
 *  3. SEC3-AUTH-6: `GET /oauth/authorize` needed `stepUp: true`, and `withStepUp` was absent from
 *     RAW_PIPELINE. The route table would have displayed a gate that could never fire.
 *
 * In all three the route table LOOKED right. Nothing structural catches it, because the flag and
 * the chain that reads it are declared in different files and neither mentions the other. So the
 * assertion here is behavioural: for every route in the table that declares `stepUp`, a live,
 * full, email-verified session whose second factor is OLD must be REFUSED — whatever pipeline
 * that route happens to run.
 *
 * `withStepUp` sits before `withSpendGate`, `withCsrf` and `withIdempotency`, and well before any
 * handler, so no route needs a valid body or a real `:id` to reach the decision — which is what
 * makes a table-wide sweep honest here rather than a set of special cases.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

/** Older than `stepUpWindowMs` (5 min) by an hour — unambiguously stale, not a boundary case. */
const STALE = new Date(FIXED_NOW.getTime() - 60 * 60_000);

describe("every `stepUp` route actually enforces it", () => {
  it("refuses a stale second factor on EVERY route that declares the flag", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: STALE });
    const id = randomUUID();

    const stepUpRoutes = apiRoutes.filter((r) => r.options?.stepUp);
    // A sweep over an empty set passes vacuously; assert the set is real first.
    expect(stepUpRoutes.length).toBeGreaterThan(0);

    const admitted: string[] = [];
    for (const route of stepUpRoutes) {
      const path = route.pattern.split("/").map((p) => (p.startsWith(":") ? id : p)).join("/");
      const res = await H(req(route.method, path, { bearer: s.token }), deps);
      const body = await res.json().catch(() => ({})) as { error?: { code?: string } };
      if (res.status !== 403 || body.error?.code !== "step_up_required") {
        admitted.push(`${route.method} ${path} → ${res.status} ${body.error?.code ?? "(no code)"}`);
      }
    }
    expect(admitted, "routes declaring `stepUp` that a STALE factor still reaches").toEqual([]);
  });

  /**
   * The other half, and the one that keeps the sweep above from being satisfiable by a gate that
   * refuses everything: the same routes must ADMIT a fresh factor. Without this, deleting the
   * `withinWindow` test and always returning 403 would pass the census.
   *
   * These then answer 400/404/402/409 for their own reasons — the assertion is only that the
   * STEP-UP refusal is gone once the factor is fresh.
   */
  it("admits a FRESH second factor on the same routes", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const id = randomUUID();

    const refused: string[] = [];
    for (const route of apiRoutes.filter((r) => r.options?.stepUp)) {
      const path = route.pattern.split("/").map((p) => (p.startsWith(":") ? id : p)).join("/");
      const res = await H(req(route.method, path, { bearer: s.token }), deps);
      if (res.status !== 403) continue;
      const body = await res.json().catch(() => ({})) as { error?: { code?: string } };
      if (body.error?.code === "step_up_required") refused.push(`${route.method} ${path}`);
    }
    expect(refused, "routes that refuse a FRESH factor — the gate is stuck closed").toEqual([]);
  });

  /**
   * SEC3-AUTH-6 named. `GET /oauth/authorize` is the route the census was extended for, and the
   * only one in the table that is both `raw` and `stepUp` — so it is the one whose enforcement
   * depends on the RAW_PIPELINE membership rather than on FULL_PIPELINE.
   */
  it("`GET /oauth/authorize` is raw AND step-up gated — the combination the pipeline had to learn", () => {
    const authorize = apiRoutes.find((r) => r.method === "GET" && r.pattern === "/oauth/authorize");
    expect(authorize, "the route must exist for this census to mean anything").toBeDefined();
    expect(authorize!.options?.raw).toBe(true);
    expect(authorize!.options?.stepUp).toBe(true);
    expect(authorize!.options?.public).toBe(true);
  });
});
