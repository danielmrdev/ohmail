import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, applyScreenerDecision, changeLog, folderState, mailboxes, messageBodies, messages,
  recordChange, rules, type Tx,
} from "@trafficflow/db";
import { autoFiledSummary, undoAutoFiled, type ServiceContext } from "@trafficflow/services";
import { newScreenerAutoWalk, screenerAutoApplyPass } from "../src/screener-auto.js";
import { ruleRetroPass } from "../src/rule-retro.js";

/**
 * PUT BACK IS NEVER FILED AGAIN (row 140). The auto-apply pass files obvious bulk out of the
 * Screener and writes its undo to the audit log; nothing read it. The read now lists what the pass
 * filed that is still where it put it, and the undo moves it back to the gate through the move
 * door — whose `last_set_by = 'us'` the pass's candidate statement admits — marking
 * `auto_filing_undone_at` in the same transaction, the statement's sixth exclusion.
 */

const SCREENER = "ohmail/Screener";
const STRONG_BULK = { "list-unsubscribe": ["<https://x.test/u>"], "list-id": ["<news.shop.test>"] };

async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "put-back" });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 6)}@example.test`, organizerRole: "organizer",
  }).returning();
  await db.insert(accountSettings).values({ accountId, screenerAutoApplyAt: new Date() });
  let n = 0;
  const bulk = async (from: string) => db.transaction(async (tx) => {
    const i = n++;
    const [m] = await tx.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `pb:${randomUUID()}`, subject: `Weekly news ${i}`,
      fromAddress: from, nativeLocator: { folder: SCREENER, ref: `1:${i}` },
    }).returning();
    await tx.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: STRONG_BULK });
    await tx.insert(folderState).values({ messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false });
    await recordChange(tx as never, { accountId, entityType: "message", entityId: m!.id, op: "create", meta: null });
    return m!.id;
  });
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => new Date(), requestId: "pb" };
  const desired = async (id: string) =>
    (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
  return { db, accountId, ctx, bulk, desired };
}

describe("the Screener's automatic filing, put back", () => {
  it("lists what the pass filed, puts it back desired-only, and a full walk never files it again", async () => {
    const w = await world();
    const a = await w.bulk("news@shop.test");
    const b = await w.bulk("deals@shop.test");
    const filed = await screenerAutoApplyPass(w.db, { accountId: w.accountId, walk: newScreenerAutoWalk() });
    expect(filed.moved, "premise: the pass files both").toBe(2);

    const listed = await autoFiledSummary(w.db, w.accountId);
    expect(listed.items.map((i) => i.messageId).sort()).toEqual([a, b].sort());
    expect(listed.items.every((i) => i.to === "ohmail/News")).toBe(true);

    const seqBefore = (await w.db.select().from(changeLog).where(eq(changeLog.accountId, w.accountId))).length;
    expect(await undoAutoFiled(w.ctx, { messageIds: [a] })).toEqual({ putBack: [a], requested: [] });
    expect(await w.desired(a), "desired only: the reconciler moves the mail").toBe(SCREENER);
    const moves = (await w.db.select().from(changeLog).where(eq(changeLog.accountId, w.accountId))).slice(seqBefore);
    expect(moves.some((c) => c.entityId === a && c.op === "move"), "the move rides a change row").toBe(true);
    expect((await autoFiledSummary(w.db, w.accountId)).items.map((i) => i.messageId)).toEqual([b]);

    // The sixth exclusion: a FULL walk (a fresh walk state) sees the row held with `us` and leaves it.
    const again = await screenerAutoApplyPass(w.db, { accountId: w.accountId, walk: newScreenerAutoWalk() });
    expect({ moved: again.moved, desired: await w.desired(a) }).toEqual({ moved: 0, desired: SCREENER });
  });

  it("a held twin nobody put back is filed by the same walk (the control)", async () => {
    const w = await world();
    const a = await w.bulk("news@shop.test");
    await screenerAutoApplyPass(w.db, { accountId: w.accountId, walk: newScreenerAutoWalk() });
    await undoAutoFiled(w.ctx, { messageIds: [a] });
    const twin = await w.bulk("news@shop.test");
    const again = await screenerAutoApplyPass(w.db, { accountId: w.accountId, walk: newScreenerAutoWalk() });
    expect({ moved: again.moved, a: await w.desired(a), twin: await w.desired(twin) })
      .toEqual({ moved: 1, a: SCREENER, twin: "ohmail/News" });
  });

  it("a replay puts nothing back twice, and an id the pass never filed is skipped", async () => {
    const w = await world();
    const a = await w.bulk("news@shop.test");
    await screenerAutoApplyPass(w.db, { accountId: w.accountId, walk: newScreenerAutoWalk() });
    await undoAutoFiled(w.ctx, { messageIds: [a] });
    expect(await undoAutoFiled(w.ctx, { messageIds: [a, randomUUID()] })).toEqual({ putBack: [], requested: [] });
  });

  it("a filing the person already moved elsewhere is no longer the pass's, and is neither listed nor put back", async () => {
    const w = await world();
    const a = await w.bulk("news@shop.test");
    await screenerAutoApplyPass(w.db, { accountId: w.accountId, walk: newScreenerAutoWalk() });
    await w.db.update(folderState).set({ desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "external" })
      .where(eq(folderState.messageId, a));
    expect((await autoFiledSummary(w.db, w.accountId)).items).toEqual([]);
    expect(await undoAutoFiled(w.ctx, { messageIds: [a] })).toEqual({ putBack: [], requested: [] });
    expect(await w.desired(a), "the person's own move stands").toBe("INBOX");
  });

  it("refuses a malformed or oversized list", async () => {
    const w = await world();
    const refused = async (messageIds: unknown) => {
      try { await undoAutoFiled(w.ctx, { messageIds }); return "admitted"; }
      catch (e) { return (e as { httpStatus?: number }).httpStatus === 400 ? "refused" : String(e); }
    };
    expect(await refused(undefined)).toBe("refused");
    expect(await refused([])).toBe("refused");
    expect(await refused([7])).toBe("refused");
    expect(await refused(Array.from({ length: 101 }, () => randomUUID()))).toBe("refused");
    expect(await refused([randomUUID()]), "the control: a well-formed list is admitted").toBe("admitted");
  });
});

/* THE AUTOMATIC PATHS PAST THE PASS'S OWN (L2): the act on suggestions
   decides a sender through the Screener's decide door, whose held bag and whose rule's backlog walk
   would file the put-back message again. Both leave it; a person's own decision still moves it. */
describe("a put-back message is filed by no automatic decision, and by a person's", () => {
  async function putBack() {
    const w = await world();
    const a = await w.bulk("news@shop.test");
    await screenerAutoApplyPass(w.db, { accountId: w.accountId, walk: newScreenerAutoWalk() });
    await undoAutoFiled(w.ctx, { messageIds: [a] });
    const decide = (decidedBy: "pass" | "person") => w.db.transaction(async (tx) => applyScreenerDecision(tx as never, {
      accountId: w.accountId, scope: "sender", address: "news@shop.test", appliedFolder: "ohmail/News" as never,
      decision: "yes", triggeringActionId: `screener:auto:${decidedBy}`, now: new Date(), stampBaseline: false,
      applyRetro: true, decidedBy, overExisting: "converge",
    }));
    return { w, a, decide };
  }

  it("the act on suggestions' decision leaves it at the gate — its held bag and its rule's walk", async () => {
    const { w, a, decide } = await putBack();
    await decide("pass");
    expect(await w.desired(a), "the decide door's held bag").toBe(SCREENER);
    await ruleRetroPass(w.db, { accountId: w.accountId, trustedAuthservIdsFor: async () => new Set<string>() });
    expect(await w.desired(a), "the pass's rule walking the sender's backlog").toBe(SCREENER);
  });

  it("a person's decision for the sender moves it (the control)", async () => {
    const { w, a, decide } = await putBack();
    await decide("person");
    expect(await w.desired(a)).toBe("ohmail/News");
  });

  it("a promoted rule the act did not write — a \"Not junk\" rescue — walks it", async () => {
    const { w, a } = await putBack();
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "news@shop.test", destination: "ohmail/News", provenance: "promoted",
      enabled: true, priority: 0, retroRequestedAt: new Date(),
    });
    await ruleRetroPass(w.db, { accountId: w.accountId, trustedAuthservIdsFor: async () => new Set<string>() });
    expect(await w.desired(a)).toBe("ohmail/News");
  });

  it("a rule a person wrote walks it too (the control for the walk)", async () => {
    const { w, a } = await putBack();
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "news@shop.test", destination: "ohmail/News", provenance: "manual",
      enabled: true, priority: 0, retroRequestedAt: new Date(),
    });
    await ruleRetroPass(w.db, { accountId: w.accountId, trustedAuthservIdsFor: async () => new Set<string>() });
    expect(await w.desired(a)).toBe("ohmail/News");
  });
});

/* PAST THE NEWEST 400 (L3): a window of recent audit rows filled with
   put-back filings, the list read empty and the older filings stayed out of the Screener. */
describe("every filing is reachable, however many there are", () => {
  it("450 filings: Put back all, pressed until the list is empty, leaves none filed", async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 450; i++) ids.push(await w.bulk(`news${i}@shop${i}.test`));
    for (let k = 0; k < 20; k++) {
      const r = await screenerAutoApplyPass(w.db, { accountId: w.accountId, walk: newScreenerAutoWalk() });
      if (r.moved === 0) break;
    }
    const filed: string[] = [];
    for (const id of ids) if (await w.desired(id) !== SCREENER) filed.push(id);
    expect(filed.length, "premise: the pass filed them").toBe(450);
    let rounds = 0;
    for (;;) {
      const page = await autoFiledSummary(w.db, w.accountId);
      if (page.items.length === 0) break;
      await undoAutoFiled(w.ctx, { messageIds: page.items.map((i) => i.messageId) });
      if (++rounds > 10) break;
    }
    const still = [];
    for (const id of filed) if (await w.desired(id) !== SCREENER) still.push(id);
    expect({ rounds, still: still.length }).toEqual({ rounds: 5, still: 0 });
  }, 240_000);
});
