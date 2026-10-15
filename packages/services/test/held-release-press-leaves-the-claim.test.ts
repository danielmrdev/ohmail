import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { carryDialect } from "@trafficflow/db/dialect";
import { accounts, applyScreenerDecision, contacts, folderState, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { heldReleaseSenders, releaseHeld } from "../src/held-release-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE HELD-RELEASE PRESS NEVER TAKES A CLAIM (mail 0148). The contact line never counts a marked
 * row, and its press moves exactly what it counted: the claim beside them stays at the gate for its
 * own press, made on its own sentence. The person's own Screener press on that sender still moves it.
 */
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const SENDER = "kundendienst@karten-service.test";

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `hr-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "organizer",
  }).returning();
  const held = async (name: string, check: "none" | "impersonation" | null, n: number, authVerdict: string | null = null) => {
    const at = new Date(`2026-10-06T0${n}:00:00.000Z`);
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `hr:${randomUUID()}`,
      subject: `m${n}`, snippet: "", fromAddress: SENDER, fromName: name, authVerdict,
      senderCheck: check, senderCheckBrand: check === "impersonation" ? "PostFinance" : null,
      date: at, unread: true, createdAt: at, nativeLocator: { folder: GATE, ref: `1:${n}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  await db.insert(contacts).values({ accountId, address: SENDER, source: "inferred" });
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `hr-${randomUUID().slice(0, 8)}` };
  const desired = async (id: string) =>
    (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
  return { db, accountId, ctx, held, desired };
}

describe("the held-release contact line and a claim beside it", () => {
  it("checks an unchecked row before its press moves it: an unchecked claim stays, marked", async () => {
    const w = await world();
    const benign = await w.held("Anna Meier", null, 1);
    const claim = await w.held("PostFinance", null, 2);
    await releaseHeld(w.ctx, { senders: [SENDER] });
    expect(await w.desired(benign)).toBe("INBOX");
    expect(await w.desired(claim)).toBe(GATE);
    const [marked] = await w.db.select({ c: messages.senderCheck, b: messages.senderCheckBrand }).from(messages).where(eq(messages.id, claim));
    expect(marked).toEqual({ c: "impersonation", b: "PostFinance" });
  });

  it("offers every row but the claim, and its press moves exactly those and leaves the claim", async () => {
    const w = await world();
    const benign = await w.held("Anna Meier", "none", 1);
    const claim = await w.held("PostFinance", "impersonation", 2);
    const unchecked = await w.held("Anna Meier", null, 3);
    expect(await heldReleaseSenders(w.db as never, w.accountId)).toEqual([{ sender: SENDER, count: 2 }]);
    const r = await releaseHeld(w.ctx, { senders: [SENDER] });
    expect(r.total).toBe(2);
    expect(await w.desired(benign)).toBe("INBOX");
    expect(await w.desired(unchecked)).toBe("INBOX");
    expect(await w.desired(claim)).toBe(GATE);
  });

  it("never counts or moves a row that FAILED authentication: its provider says it is not the contact's", async () => {
    const w = await world();
    const forged = await w.held("Anna Meier", "none", 1, "fail");
    const genuine = await w.held("Anna Meier", "none", 2, "pass");
    expect(await heldReleaseSenders(w.db as never, w.accountId)).toEqual([{ sender: SENDER, count: 1 }]);
    const r = await releaseHeld(w.ctx, { senders: [SENDER] });
    expect(r.total).toBe(1);
    expect(await w.desired(forged)).toBe(GATE);
    expect(await w.desired(genuine)).toBe("INBOX");
  });

  it("CONTROL: the person's own press on the sender's row moves the claim", async () => {
    const w = await world();
    const claim = await w.held("PostFinance", "impersonation", 2);
    await w.db.transaction((tx) => applyScreenerDecision(carryDialect(w.db, tx) as never, {
      accountId: w.accountId, scope: "sender", address: SENDER, appliedFolder: "INBOX", decision: "yes",
      triggeringActionId: "press", now: NOW, overExisting: "converge", decidedBy: "person",
    }));
    expect(await w.desired(claim)).toBe("INBOX");
  });
});
