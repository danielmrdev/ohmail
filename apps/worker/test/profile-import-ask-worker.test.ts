import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import {
  PROFILE_IMPORT_ASK_TTL_MS, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION, accounts, auditLog, changeLog, contacts,
  fencedAccountWrite, mailboxes, recordImportAsk, tags, type LedgerTx, type Tx,
} from "@trafficflow/db";
import { applyOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { makeDb } from "@trafficflow/db/cloud";
import { formatProfileMessage, makeProfileDoc, profileFingerprint, type OrganizerProfilePayload } from "@trafficflow/core/adapters/organizer-profile";
import { OrganizerProfileSync } from "../src/profile.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * THE ORGANIZER FINISHES A PRESS THE REQUEST COULD NOT. The ask is on the mailbox row (mail 0129);
 * the organizer reads it by primary key BEFORE its five-minute debounce, reads the document on its
 * own (pinned) connection, and applies it through the one merge — or refuses by name. These drive
 * `OrganizerProfileSync` tick by tick against the fake folder, with the SHIPPED debounce.
 */

type Db = ReturnType<typeof makeDb>;
let DB = "";
const INSTALL = "organizer-under-test";
const INTERVAL = 5 * 60 * 1000;
const PAYLOAD: OrganizerProfilePayload = {
  screener: [{ address: "friend@elsewhere.example" }],
  rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs"], signature: null,
};
const FOREIGN = makeProfileDoc(PAYLOAD, { updatedAt: new Date("2026-09-01T00:00:00Z"), producer: { kind: "local", version: "0.25.1" } });
const FP = profileFingerprint(FOREIGN);

async function seed(db: Db): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "ask" });
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`, organizerRole: "organizer",
    organizeConsentedAt: new Date(Date.now() - 60 * 60 * 1000),
  }).returning();
  return { accountId, mailboxId: row!.id };
}

function sync(db: Db, fleet: FakeAdapterFleet, mb: { accountId: string; mailboxId: string }, now: () => Date, events: string[]) {
  const adapter = fleet.factory(
    { host: "fake.invalid", port: 1143, secure: false, auth: { user: "u", pass: "p" }, sentDomain: "t" } as never,
    { accountId: mb.accountId, mailboxId: mb.mailboxId, onConnectionError: () => undefined },
  );
  return new OrganizerProfileSync({
    db, accountId: mb.accountId, mailboxId: mb.mailboxId, adapter,
    self: { installId: INSTALL, kind: "cloud" }, producerVersion: "dev", flushIntervalMs: INTERVAL, now,
    log: (event, detail) => { events.push(`${event} ${JSON.stringify(detail)}`); },
  });
}

async function askOf(db: Db, mailboxId: string) {
  const [r] = await db.select({
    fp: mailboxes.profileImportAskFingerprint, outcome: mailboxes.profileImportAskOutcome,
    reason: mailboxes.profileImportAskReason,
  }).from(mailboxes).where(eq(mailboxes.id, mailboxId));
  return r!;
}

describe("the organizer's tick answers a handed-over press", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_profile_ask"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("inside the debounce, the ask runs the merge on this tick, rings the settings doorbell, and reads once", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seed(db);
    await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(FOREIGN, { installId: "another-mac" }));
    let now = new Date("2026-09-26T20:00:00Z");
    const events: string[] = [];
    const s = sync(db, fleet, mb, () => now, events);
    await s.onOrganize(); // seed: the foreign document is held
    now = new Date(now.getTime() + 1000); // well inside the five-minute debounce
    await recordImportAsk(db as unknown as Tx, { accountId: mb.accountId, mailboxId: mb.mailboxId, fingerprint: FP, now });
    const reads = fleet.metaFor(mb.mailboxId).profileReads;
    await s.onOrganize();
    expect(await askOf(db, mb.mailboxId)).toMatchObject({ fp: FP, outcome: "imported", reason: null });
    expect((await db.select().from(contacts).where(eq(contacts.accountId, mb.accountId))).map((c) => c.address))
      .toEqual(["friend@elsewhere.example"]);
    expect((await db.select().from(tags).where(eq(tags.accountId, mb.accountId))).map((t) => t.name)).toEqual(["theirs"]);
    const bells = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, mb.accountId), eq(changeLog.entityType, "settings")));
    expect(bells.length, "the settings doorbell").toBeGreaterThanOrEqual(1);
    // One read for the ask, and the resolved arm's re-derivation — on the one pinned connection.
    expect(fleet.metaFor(mb.mailboxId).profileReads - reads).toBeLessThanOrEqual(2);
    expect(events.some((e) => e.startsWith("organizer_profile_import_answered") && e.includes("imported"))).toBe(true);
  }, 60_000);

  it("a document that changed since the press is refused `changed`, and nothing is applied", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seed(db);
    await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(FOREIGN, { installId: "another-mac" }));
    let now = new Date("2026-09-26T20:00:00Z");
    const s = sync(db, fleet, mb, () => now, []);
    await s.onOrganize();
    now = new Date(now.getTime() + 1000);
    await recordImportAsk(db as unknown as Tx, { accountId: mb.accountId, mailboxId: mb.mailboxId, fingerprint: "not-this-document", now });
    await s.onOrganize();
    expect(await askOf(db, mb.mailboxId)).toMatchObject({ outcome: "refused", reason: "changed" });
    expect(await db.select().from(contacts).where(eq(contacts.accountId, mb.accountId))).toEqual([]);
  }, 60_000);

  it("a read that fails leaves the ask standing for the next tick; past the TTL it is `timed_out`", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seed(db);
    await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(FOREIGN, { installId: "another-mac" }));
    let now = new Date("2026-09-26T20:00:00Z");
    const events: string[] = [];
    const s = sync(db, fleet, mb, () => now, events);
    await s.onOrganize();
    now = new Date(now.getTime() + 1000);
    await recordImportAsk(db as unknown as Tx, { accountId: mb.accountId, mailboxId: mb.mailboxId, fingerprint: FP, now });
    fleet.metaFor(mb.mailboxId).deadConnection = true;
    await s.onOrganize();
    expect(await askOf(db, mb.mailboxId)).toMatchObject({ fp: FP, outcome: null });
    expect(events.some((e) => e.startsWith("organizer_profile_import_retry"))).toBe(true);
    now = new Date(now.getTime() + PROFILE_IMPORT_ASK_TTL_MS);
    await s.onOrganize();
    expect(await askOf(db, mb.mailboxId)).toMatchObject({ fp: FP, outcome: "refused", reason: "timed_out" });
  }, 60_000);

  /* THE TWO MERGES RACING ON ONE ACCOUNT, on a real Postgres: the confirm route's inline merge (a
     press that read in time) against the organizer's job for the same ask. The advisory lock
     serializes the transactions and the compare-and-set answers the ask once; both orders. */
  for (const order of ["tick-first", "inline-first"] as const) {
    it(`the inline merge and the tick's merge race: one resolution, one row per key, imported once (${order})`, async () => {
      const db = makeDb(DB);
      const fleet = new FakeAdapterFleet();
      const mb = await seed(db);
      await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(FOREIGN, { installId: "another-mac" }));
      let now = new Date("2026-09-26T20:00:00Z");
      const s = sync(db, fleet, mb, () => now, []);
      await s.onOrganize();
      now = new Date(now.getTime() + 1000);
      await recordImportAsk(db as unknown as Tx, { accountId: mb.accountId, mailboxId: mb.mailboxId, fingerprint: FP, now });
      // The confirm route's shape exactly: the account fence alone (`profile-import-service.ts#apply`).
      const inline = (): Promise<unknown> => fencedAccountWrite(db as unknown as Tx, { accountId: mb.accountId },
        async (tx) => applyOrganizerProfile(tx as LedgerTx, { accountId: mb.accountId, mailboxId: mb.mailboxId, doc: FOREIGN, fingerprint: FP, now }));
      const tick = (): Promise<unknown> => s.onOrganize();
      await Promise.all(order === "tick-first" ? [tick(), inline()] : [inline(), tick()]);
      expect(await db.select().from(contacts).where(eq(contacts.accountId, mb.accountId))).toHaveLength(1);
      expect(await db.select().from(tags).where(eq(tags.accountId, mb.accountId))).toHaveLength(1);
      const resolutions = await db.select().from(auditLog).where(and(
        eq(auditLog.accountId, mb.accountId), eq(auditLog.action, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION),
      ));
      expect(resolutions, "one imported answer for the one document").toHaveLength(1);
      expect(await askOf(db, mb.mailboxId)).toMatchObject({ fp: FP, outcome: "imported" });
    }, 60_000);
  }

  /* THE OVERLAP ITSELF. The two orders above serialize before the transactions meet. Here the
     inline merge takes the merge's lock and parks on a contact row a third session holds; the tick
     then takes its fence and waits; released, the inline merge updates the mailbox row. With the
     tick's fence a share, that update waits on the tick's share while the tick waits on the lock,
     and Postgres aborts one. FOR UPDATE at the fence's head makes the tick wait at the fence. */
  it("the tick's fence meeting an inline merge that holds the lock: both commit, neither is a deadlock victim", async () => {
    const named = (name: string): string => { const u = new URL(DB); u.searchParams.set("application_name", name); return u.toString(); };
    const tag = randomUUID().slice(0, 8);
    const TICK = `fix025-tick-${tag}`;
    const INLINE = `fix025-inline-${tag}`;
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seed(db);
    await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(FOREIGN, { installId: "another-mac" }));
    let now = new Date("2026-09-26T20:00:00Z");
    const events: string[] = [];
    const s = sync(makeDb(named(TICK)), fleet, mb, () => now, events);
    await s.onOrganize();
    now = new Date(now.getTime() + 1000);
    await recordImportAsk(db as unknown as Tx, { accountId: mb.accountId, mailboxId: mb.mailboxId, fingerprint: FP, now });
    await db.insert(contacts).values({ accountId: mb.accountId, address: "friend@elsewhere.example" });

    const probe = postgres(DB, { max: 1, onnotice: () => undefined });
    const gate = postgres(DB, { max: 1, onnotice: () => undefined });
    try {
      const waiting = async (name: string): Promise<void> => {
        for (let i = 0; i < 400; i++) {
          const [r] = await probe`select count(*)::int as n from pg_stat_activity
            where datname = current_database() and application_name = ${name} and wait_event_type = 'Lock'`;
          if ((r as { n: number }).n > 0) return;
          await new Promise((res) => setTimeout(res, 25));
        }
        throw new Error(`${name} never waited on a lock`);
      };
      let release!: () => void;
      const released = new Promise<void>((res) => { release = res; });
      let held!: () => void;
      const holding = new Promise<void>((res) => { held = res; });
      const holder = gate.begin(async (tx) => {
        await tx`select 1 from contacts where account_id = ${mb.accountId} and address = 'friend@elsewhere.example' for update`;
        held();
        await released;
      });
      await holding;
      const inline = fencedAccountWrite(makeDb(named(INLINE)) as unknown as Tx, { accountId: mb.accountId },
        async (tx) => applyOrganizerProfile(tx as LedgerTx, { accountId: mb.accountId, mailboxId: mb.mailboxId, doc: FOREIGN, fingerprint: FP, now }))
        .then(() => "committed", (err: unknown) => `refused: ${String((err as { code?: string }).code ?? err)}`);
      await waiting(INLINE); // the merge's lock taken, parked on the held contact
      const tick = s.onOrganize();
      await waiting(TICK); // the tick at its fence, or on the merge's lock
      release();
      await holder;
      expect(await inline, "the inline merge was aborted").toBe("committed");
      await tick;
      expect(events.filter((e) => e.startsWith("organizer_profile_write_failed")), "the tick's merge was aborted").toEqual([]);
      expect(await askOf(db, mb.mailboxId)).toMatchObject({ fp: FP, outcome: "imported" });
    } finally {
      await probe.end({ timeout: 5 });
      await gate.end({ timeout: 5 });
    }
  }, 60_000);

  it("CONTROL: with no ask, the debounce still holds — no read inside the interval", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seed(db);
    await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(FOREIGN, { installId: "another-mac" }));
    let now = new Date("2026-09-26T20:00:00Z");
    const s = sync(db, fleet, mb, () => now, []);
    await s.onOrganize();
    const reads = fleet.metaFor(mb.mailboxId).profileReads;
    now = new Date(now.getTime() + 1000);
    await s.onOrganize();
    expect(fleet.metaFor(mb.mailboxId).profileReads).toBe(reads);
  }, 60_000);
});
