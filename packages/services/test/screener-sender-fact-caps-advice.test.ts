import { describe, expect, it } from "vitest";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, folderState, mailboxes, messageBodies, messages, routingDecisions,
  SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS,
} from "@trafficflow/db";
import { ScreenerService } from "../src/screener-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE SENDER'S FACT CAPS THE ADVICE WHATEVER MESSAGE IT WAS BOUGHT ON (mail 0148): the queue
 * row is the sender's newest held message, which claims nothing, and an OLDER one claims
 * PostFinance from a gmail address. The row carries the fact aggregated over both, and the stored
 * an "Ohbox" suggestion bought on the benign message is shown capped with the reason beside it. On
 * whichever store the project runs: the aggregate is a window both stores spell alike.
 */
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const SENDER = personalAt("fixture.mila", "gmail.com");

async function world(opts: { olderMarked: boolean }) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `cap-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "organizer",
  }).returning();
  const held = async (at: Date, fromName: string, senderCheck: "none" | "impersonation") => {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: randomUUID(), dedupKey: `cap:${randomUUID()}`,
      subject: "Ihre Karte", snippet: "", fromAddress: SENDER, fromName,
      senderCheck, senderCheckBrand: senderCheck === "impersonation" ? "PostFinance" : null,
      date: at, unread: true, createdAt: at, nativeLocator: { folder: GATE, ref: `1:${randomUUID().slice(0, 6)}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  await held(new Date("2026-10-06T08:00:00.000Z"), opts.olderMarked ? "PostFinance" : "Kundendienst",
    opts.olderMarked ? "impersonation" : "none");
  const newest = await held(new Date("2026-10-06T09:00:00.000Z"), "Kundendienst", "none");
  await db.insert(routingDecisions).values({
    accountId, messageId: newest, inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
    destination: "INBOX", confidence: 0.95, rationale: "a customer service desk", spam: false, status: SCREENER_SUGGESTION_STATUS,
  } as never);
  const ctx: ServiceContext = {
    db: db as never, accountId, userId: null, now: () => NOW, requestId: `cap-${randomUUID().slice(0, 8)}`,
  };
  return { ctx, newest };
}

describe("the sender's identity fact caps the advice bought on another of their messages", () => {
  it("the row is the benign newest message, and its advice is capped by the older marked one", async () => {
    const w = await world({ olderMarked: true });
    const { items } = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    expect(items.map((i) => i.messageId)).toEqual([w.newest]);
    expect(items[0]!.checked).toEqual({ reason: "impersonation", brand: "PostFinance", domainShared: true });
    expect(items[0]!.aiSuggestion).toMatchObject({ reasonCode: "impersonation", reasonBrand: "PostFinance" });
    expect(items[0]!.aiSuggestion!.decision).not.toBe("yes");
  });

  it("CONTROL: with neither message marked the row says no fact and the advice stands as bought", async () => {
    const w = await world({ olderMarked: false });
    const { items } = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    expect(items[0]!.checked).toBeUndefined();
    expect(items[0]!.aiSuggestion).toMatchObject({ destination: "INBOX", decision: "yes", confidence: 0.95 });
    expect(items[0]!.aiSuggestion!.reasonCode).toBeUndefined();
  });
});
