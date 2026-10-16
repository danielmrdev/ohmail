import { describe, expect, it } from "vitest";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import {
  accounts, mailboxes, mailboxProfileMirror, organizerRequests, rules as rulesTbl,
  markRequestsSent, markRequestsApplied, settleReaderRuleRows,
} from "@trafficflow/db";
import { FIXED_NOW, makeDeps, seedSession } from "../../api/test/helpers.js";
import { HttpAdapter, OhmailEngine, rulesList, type FetchLike } from "@ohmail/client-engine";
import { makeTestDb } from "../../db/src/testing.js";
import { applyRuleRequest, validateRulePayload } from "../../db/src/request-apply.js";
import type { LedgerTx, Tx } from "../../db/src/change-log.js";

// VERIFY-026 HIGH 1, the verifier's probe kept as the control. ADAPTED (ARCH-RULES-PAGE-INVARIANT §5)
// only where it named removed symbols: the page is read through `rulesList(engine.read())`, the
// shipped reader behind the Rules page, and the drain stand-in settles with the request's
// `decidedAt`; the server clock advances per request, as production's does. A reader-only account
// whose organizer published once and whose cached copy is NOT re-read before the second press.
const app = createApp(apiRoutes);

async function world() {
  const { db, deps, clock } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW });
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set("authorization", `Bearer ${s.token}`);
    clock.advance(1000);
    return app.handle(new Request(url, { ...init, headers }), { ...deps, session: null, idempotency: null } as ApiDeps);
  };
  const made = await fetchImpl("http://localhost/rules", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "sender", match: "ann@shop.example", destination: "ohmail/News" }),
  });
  expect(made.status).toBe(201);
  const ruleId = ((await made.json()) as { id: string }).id;
  const [mb] = await db.insert(mailboxes).values({
    accountId: s.accountId, provider: "imap", address: "reader@shop.test", organizerRole: "reader",
    organizerState: "held", organizedByCapabilities: "requests,rules,moves,profile", organizedByKind: "local", organizedByName: "Laptop",
  }).returning();
  const org = await makeTestDb();
  const [oa] = await org.insert(accounts).values({ name: "organizer" }).returning();
  await org.insert(rulesTbl).values({ accountId: oa!.id, kind: "sender", match: "ann@shop.example", destination: "ohmail/News", priority: 0, enabled: true, provenance: "manual" });
  const publish = async () => {
    const doc = { rules: await org.select({
      kind: rulesTbl.kind, match: rulesTbl.match, destination: rulesTbl.destination, priority: rulesTbl.priority,
      enabled: rulesTbl.enabled, provenance: rulesTbl.provenance, subjectContains: rulesTbl.subjectContains, bodyContains: rulesTbl.bodyContains,
    }).from(rulesTbl) };
    await db.insert(mailboxProfileMirror).values({ mailboxId: mb!.id, accountId: s.accountId, doc })
      .onConflictDoUpdate({ target: mailboxProfileMirror.mailboxId, set: { doc, readAt: new Date() } });
  };
  await publish(); // the organizer's one publication the reader has cached
  let carried = 0;
  /** The organizer applies the next travelled request; the reader's cycle records the ack (worker's unit). */
  const organizerApplies = async () => {
    const rows = (await db.select().from(organizerRequests))
      .sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
    const r = rows[carried++]!;
    const payload = validateRulePayload(r.kind, r.payload)!;
    const outcome = await (org as unknown as Tx).transaction((tx) =>
      applyRuleRequest(tx as unknown as LedgerTx, { accountId: oa!.id, payload, now: FIXED_NOW }));
    if ((outcome as { applied?: boolean }).applied) {
      await (db as unknown as Tx).transaction(async (tx) => {
        await markRequestsSent(tx as never, [r.id], FIXED_NOW);
        await markRequestsApplied(tx as never, [r.id], FIXED_NOW);
        await settleReaderRuleRows(tx as never, s.accountId, { kind: r.kind, payload: r.payload, decidedAt: r.decidedAt });
      });
    }
    return { outcome, wire: r.payload as { shown?: unknown } };
  };
  const fresh = async () => {
    const e = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }), now: () => new Date(FIXED_NOW.getTime() + 1000) });
    await e.start();
    return e;
  };
  const engine = await fresh();
  const orgRule = async () => (await org.select({ d: rulesTbl.destination }).from(rulesTbl)).map((x) => x.d);
  return { db, ruleId, engine, fresh, organizerApplies, publish, orgRule };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? String(v) : v);

describe("VERIFY-026 probe: the second press before the published copy is re-read", () => {
  for (const second of ["edit-again", "undo", "remove"] as const) {
    it(`edit, organizer applies, ack recorded, copy NOT re-read, then ${second}`, async () => {
      const w = await world();
      expect((await w.engine.mutate({ kind: "rule_update", ruleId: w.ruleId, destination: "ohmail/Receipts" as never })).status).toBe("awaiting_organizer");
      const first = await w.organizerApplies();
      expect(first.outcome).toMatchObject({ applied: true });
      await w.engine.syncOnce();
      w.engine.refreshWaitingOnOrganizer();
      await tick();
      const ann = rulesList(w.engine.read()).map((r) => r.destination);
      const note = w.engine.waitingOnOrganizer().map((x) => x.state);
      console.log(`PROBE ${second}: organizer now`, JSON.stringify(await w.orgRule()), "page shows", JSON.stringify(ann), "waiting states", JSON.stringify(note));
      const m = second === "edit-again"
        ? { kind: "rule_update", ruleId: w.ruleId, destination: "INBOX" }
        : second === "undo"
          ? { kind: "rule_update", ruleId: w.ruleId, destination: "ohmail/News", applyRetro: false, keepProvenance: true }
          : { kind: "rule_delete", ruleId: w.ruleId };
      expect((await w.engine.mutate(m as never)).status).toBe("awaiting_organizer");
      const two = await w.organizerApplies();
      console.log(`PROBE ${second}: second press shown`, JSON.stringify(two.wire.shown), "outcome", JSON.stringify(two.outcome, big));
      expect(ann, "the page after the applied ack").toEqual(["ohmail/Receipts"]);
      expect(two.outcome, `the ${second} after the person's own applied edit`).toMatchObject({ applied: true });
    });
  }

  it("a Remove the organizer applied, ack recorded, copy NOT re-read: does the row leave the page", async () => {
    const w = await world();
    expect((await w.engine.mutate({ kind: "rule_delete", ruleId: w.ruleId })).status).toBe("awaiting_organizer");
    const first = await w.organizerApplies();
    expect(first.outcome).toMatchObject({ applied: true, op: "delete" });
    await w.engine.syncOnce();
    w.engine.refreshWaitingOnOrganizer();
    await tick();
    const own = (await w.db.select({ d: rulesTbl.destination }).from(rulesTbl)).map((x) => x.d);
    const page = rulesList(w.engine.read()).map((r) => r.destination);
    console.log("PROBE remove-first: organizer now", JSON.stringify(await w.orgRule()), "reader own rows", JSON.stringify(own), "page shows", JSON.stringify(page), "waiting", JSON.stringify(w.engine.waitingOnOrganizer().map((x) => x.state)));
    expect(page, "the removed rule on the reader-only page after the applied ack").toEqual([]);
  });

  it("CONTROL: the same undo after the organizer republished and the reader re-read applies", async () => {
    const w = await world();
    await w.engine.mutate({ kind: "rule_update", ruleId: w.ruleId, destination: "ohmail/Receipts" as never });
    await w.organizerApplies();
    await w.publish();
    const relaunched = await w.fresh();
    await relaunched.mutate({ kind: "rule_update", ruleId: w.ruleId, destination: "ohmail/News", applyRetro: false, keepProvenance: true } as never);
    const two = await w.organizerApplies();
    console.log("PROBE control: shown", JSON.stringify(two.wire.shown), "outcome", JSON.stringify(two.outcome, big));
    expect(two.outcome).toMatchObject({ applied: true });
  });
});
