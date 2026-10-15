import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, contacts, folderState, mailboxes, messageBodies, messages, rules } from "@trafficflow/db";
import { MemoryMirrorStore, consentPartition, type EngineMessage, type RuleDTO, type SyncChange } from "@ohmail/client-engine";
import { ScreenerService } from "../src/screener-service.js";
import { cutlineCounts } from "../src/consent-cutline.js";
import { messageRowToDTO } from "../src/dto/materialize.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE COUNT BESIDE THE SCREENER COUNTS THE SENDER ITS LIST SHOWS (mail 0147). A decided sender
 * (the act's promoted rule, an inferred contact) whose claim the gate holds is waiting again: the
 * queue lists them, so `GET /consent`'s active-undecided count and the client partition's count
 * them too, on the one `senderHasHeldClaimSql` term. Runs on whichever store the matrix points at.
 * CONTROL: the same decided sender's held mail without the fact is listed nowhere and counted decided.
 */
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const SENDER = "kundendienst@karten-service.test";

async function world(claim: boolean, heldAt = new Date("2026-10-01T09:00:00.000Z")) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const own = `me-${accountId.slice(0, 8)}@ohmail.test`;
  await db.insert(accounts).values({ id: accountId, name: `hp-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: own, organizerRole: "organizer" }).returning();
  const put = async (folder: string, check: "impersonation" | "none", at: Date) => {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `hp:${randomUUID()}`, subject: "Ihre Karte", snippet: "",
      fromAddress: SENDER, fromName: check === "impersonation" ? "PostFinance" : "Anna Meier",
      senderCheck: check, senderCheckBrand: check === "impersonation" ? "PostFinance" : null,
      date: at, unread: false, createdAt: at, nativeLocator: { folder, ref: `1:${randomUUID().slice(0, 4)}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: folder, observedFolder: folder, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  };
  // The admitted first mail, then the held one, read and arrived inside the screening window: a claim
  // counts only there (mail 0148), and inside it the claim is what makes the decided sender waiting.
  await put("INBOX", "none", new Date("2026-09-30T09:00:00.000Z"));
  await put(GATE, claim ? "impersonation" : "none", heldAt);
  await db.insert(rules).values({ accountId, kind: "sender", match: SENDER, destination: "INBOX", enabled: true, priority: 0, provenance: "promoted" });
  await db.insert(contacts).values({ accountId, address: SENDER, source: "inferred" });
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `hp-${randomUUID().slice(0, 8)}` };

  // The client's copy, through the API's own projection (`messageRowToDTO`), as the parity test builds it.
  // Two reads, not a join: the device driver refuses a statement selecting two columns named `id`.
  const rows = await db.select().from(messages).where(eq(messages.accountId, accountId));
  const states = await db.select().from(folderState).where(inArray(folderState.messageId, rows.map((m) => m.id)));
  const stored = rows.map((m) => ({ m, fs: states.find((f) => f.messageId === m.id)! }));
  const storedRules = await db.select().from(rules).where(eq(rules.accountId, accountId));
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges([
    ...stored.map(({ m, fs }) => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(),
      entity: messageRowToDTO(m as never, fs as never, undefined, undefined) as unknown as EngineMessage,
    })),
    ...storedRules.map((r) => ({
      type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: NOW.toISOString(),
      entity: {
        id: r.id, kind: r.kind, match: r.match, destination: r.destination, priority: r.priority, provenance: r.provenance,
        enabled: r.enabled, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      } as unknown as RuleDTO,
    })),
  ] as SyncChange[]);
  const client = consentPartition(store, { now: NOW, ownAddresses: [own] });
  return { ctx, client };
}

describe("a held claim from a decided sender, the queue and its counts", () => {
  it("the list shows one sender and both counts read one", async () => {
    const w = await world(true);
    const page = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    expect(page.items.map((i) => i.sender.address)).toEqual([SENDER]);
    expect(page.total).toBe(1);
    expect(await cutlineCounts(w.ctx, {})).toEqual({ decidedSenders: 0, activeUndecidedSenders: 1, dormantUndecidedSenders: 0 });
    expect(w.client.counts.activeUndecidedSenders).toBe(page.items.length);
    expect(w.client.counts.dormantUndecidedSenders).toBe(0);
  });

  it("a claim that arrived before the window is listed nowhere, and both counts call the sender decided", async () => {
    // The merge-back's control for both cutoffs (server count and client partition): the same claim, dated 2021.
    const w = await world(true, new Date("2021-03-01T09:00:00.000Z"));
    const page = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    expect(page.items).toEqual([]);
    expect(await cutlineCounts(w.ctx, {})).toEqual({ decidedSenders: 1, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 });
    expect(w.client.counts.activeUndecidedSenders).toBe(0);
    expect(w.client.counts.dormantUndecidedSenders).toBe(0);
  });

  it("CONTROL: the same held mail without the fact is listed nowhere and counted decided", async () => {
    const w = await world(false);
    const page = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    expect(page.items).toEqual([]);
    expect(await cutlineCounts(w.ctx, {})).toEqual({ decidedSenders: 1, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 });
    expect(w.client.counts.activeUndecidedSenders).toBe(0);
    expect(w.client.counts.dormantUndecidedSenders).toBe(0);
  });
});
