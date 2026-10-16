import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, seedMailbox, seedMessage, req, FIXED_NOW } from "./helpers.js";

/**
 * `GET /messages/timeline?zone=` — the route hands the reader's zone to the rail, so a message at
 * 00:30 on 1 September in Zurich is September's. A malformed zone is a
 * 400; a well-formed one this runtime cannot read counts in UTC, as an unstated one does.
 *
 * Mutation watched red: the handler's `parseReaderZone` read dropped (the service called with no
 * zone) → the Zurich case.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

type Timeline = { total: number; months: Array<{ month: string; count: number }> };

async function world() {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  const mb = await seedMailbox(db, { accountId: s.accountId });
  await seedMessage(db, { accountId: s.accountId, mailboxId: mb, date: new Date("2026-08-31T22:30:00.000Z") });
  await seedMessage(db, { accountId: s.accountId, mailboxId: mb, date: new Date("2026-08-31T21:30:00.000Z") });
  return { deps, token: s.token };
}

describe("GET /messages/timeline counts the reader's months", () => {
  it("Europe/Zurich: 00:30 on 1 Sep is September, 23:30 on 31 Aug is August", async () => {
    const { deps, token } = await world();
    const res = await H(req("GET", "/messages/timeline?zone=Europe%2FZurich", { bearer: token }), deps);
    expect(res.status).toBe(200);
    const t = await res.json() as Timeline;
    expect(t.months.map((m) => [m.month, m.count])).toEqual([["2026-09", 1], ["2026-08", 1]]);
  });

  it("no zone, or one this runtime cannot read, counts in UTC", async () => {
    const { deps, token } = await world();
    for (const q of ["", "?zone=Mars%2FOlympus_Mons"]) {
      const res = await H(req("GET", `/messages/timeline${q}`, { bearer: token }), deps);
      expect(res.status, q).toBe(200);
      const t = await res.json() as Timeline;
      expect(t.months.map((m) => [m.month, m.count]), q).toEqual([["2026-08", 2]]);
    }
  });

  it("a malformed zone is a 400, never a query", async () => {
    const { deps, token } = await world();
    for (const raw of ["Europe/Zurich'; drop table messages; --", "x".repeat(65)]) {
      const res = await H(req("GET", `/messages/timeline?zone=${encodeURIComponent(raw)}`, { bearer: token }), deps);
      expect(res.status, raw).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe("validation_failed");
    }
  });
});
