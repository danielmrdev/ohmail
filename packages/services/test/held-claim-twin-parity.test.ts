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
 * THE CLIENT'S HELD-CLAIM TWIN AND THE COUNT'S DECIDED ARM ASK THE LIST'S TERM: who wrote the fact
 * (`claimInside`), the person skip and its authentication half (`personSkip`, `SCREENING_AUTH_VERDICTS`).
 * A backfilled claim, a person-consented sender's claim, and the same claim failing authentication.
 */
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const SENDER = "kundendienst@karten-service.test";
const IMPORT_DONE = new Date("2026-09-01T00:00:00.000Z");

async function world(o: { by: "ingest" | "backfill"; person: boolean; auth: string | null }) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const own = `me-${accountId.slice(0, 8)}@ohmail.test`;
  await db.insert(accounts).values({ id: accountId, name: `kp-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: own, organizerRole: "organizer", initialImportCompletedAt: IMPORT_DONE,
  }).returning();
  const put = async (folder: string, claim: boolean, at: Date) => {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `kp:${randomUUID()}`, subject: "Ihre Karte", snippet: "",
      fromAddress: SENDER, fromName: claim ? "PostFinance" : "Anna Meier",
      senderCheck: claim ? "impersonation" : "none", senderCheckBrand: claim ? "PostFinance" : null,
      senderCheckBy: claim ? o.by : "ingest", authVerdict: claim ? o.auth : null,
      date: at, arrivedAt: at, unread: false, createdAt: at, nativeLocator: { folder, ref: `1:${randomUUID().slice(0, 4)}` },
    } as never).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: folder, observedFolder: folder, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  };
  await put("INBOX", false, new Date("2026-09-30T09:00:00.000Z"));
  await put(GATE, true, new Date("2026-10-01T09:00:00.000Z"));
  await db.insert(rules).values({ accountId, kind: "sender", match: SENDER, destination: "INBOX", enabled: true, priority: 0, provenance: o.person ? "manual" : "promoted" });
  await db.insert(contacts).values({ accountId, address: SENDER, source: o.person ? "person" : "inferred" });
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `kp-${randomUUID().slice(0, 8)}` };
  const rows = await db.select().from(messages).where(eq(messages.accountId, accountId));
  const states = await db.select().from(folderState).where(inArray(folderState.messageId, rows.map((m) => m.id)));
  const storedRules = await db.select().from(rules).where(eq(rules.accountId, accountId));
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges([
    ...rows.map((m) => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(),
      entity: messageRowToDTO(m as never, states.find((f) => f.messageId === m.id)! as never, undefined, undefined) as unknown as EngineMessage,
    })),
    ...storedRules.map((r) => ({
      type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: NOW.toISOString(),
      entity: {
        id: r.id, kind: r.kind, match: r.match, destination: r.destination, priority: r.priority, provenance: r.provenance,
        enabled: r.enabled, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      } as unknown as RuleDTO,
    })),
  ] as SyncChange[]);
  const client = consentPartition(store, { now: NOW, ownAddresses: [own], firstImportDoneAt: { [mb!.id]: IMPORT_DONE.toISOString() } });
  const page = await new ScreenerService({}).list(ctx, { limit: 50 });
  const server = await cutlineCounts(ctx, {});
  return { listed: page.items.length, server, client: client.counts };
}

describe("a decided sender's held claim: the list, the server count and the client count agree", () => {
  it("a backfilled claim of a decided sender: listed nowhere, decided on both", async () => {
    const r = await world({ by: "backfill", person: false, auth: null });
    expect([r.listed, r.server.activeUndecidedSenders, r.client.activeUndecidedSenders]).toEqual([0, 0, 0]);
  });
  it("a person-consented sender's ingest claim: the person skip takes it on both", async () => {
    const r = await world({ by: "ingest", person: true, auth: null });
    expect([r.listed, r.server.activeUndecidedSenders, r.client.activeUndecidedSenders]).toEqual([0, 0, 0]);
  });
  it("the same claim failing authentication: listed, and waiting on both counts", async () => {
    const r = await world({ by: "ingest", person: true, auth: "fail" });
    expect([r.listed, r.server.activeUndecidedSenders, r.client.activeUndecidedSenders]).toEqual([1, 1, 1]);
  });
  it("CONTROL: a decided sender's ingest claim inside the window: listed and waiting on both", async () => {
    const r = await world({ by: "ingest", person: false, auth: null });
    expect([r.listed, r.server.activeUndecidedSenders, r.client.activeUndecidedSenders]).toEqual([1, 1, 1]);
  });
});
