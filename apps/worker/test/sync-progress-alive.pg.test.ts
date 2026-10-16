import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, inArray } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes } from "@trafficflow/db";
import { schema, evaluateAlerts } from "@trafficflow/db/cloud";
import {
  markMailboxReadLimited, markMailboxProviderUnavailable, stampMailboxSync, stampSyncProgress, stampImportProgress,
} from "../src/mailboxes.js";

/**
 * a first import that hits one of our ceilings is alive, not lagging (mail 0130).
 *
 * The `sync_lag` rule measured `coalesce(last_sync_at, created_at)`, and a cycle that ends on a
 * ceiling stamps no `last_sync_at`, so a first import whose cycles kept ending `read_limited`
 * paged thirty minutes after the mailbox was added while the worker was reading it. The writer
 * now stamps `sync_progress_at` on such a mailbox and the rule reads it second. Real Postgres,
 * the real writer, the real rule; each case reads its own account only (`parkedAccounts`).
 */
const AVAILABLE = await realPgAvailable();
const NOW = new Date("2026-08-01T12:00:00.000Z");
const MIN = 60_000;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe.skipIf(!AVAILABLE)("sync_progress_at — a first import that keeps reading is alive", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;
  const seeded: string[] = [];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);
  afterEach(async () => {
    const ids = seeded.splice(0);
    if (ids.length === 0) return;
    await db.delete(mailboxes).where(inArray(mailboxes.accountId, ids));
    await db.delete(accounts).where(inArray(accounts.id, ids));
  });
  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  const lagOf = async (accountId: string) => {
    const alerts = await evaluateAlerts(db, {
      now: NOW,
      parkedAccounts: async (ids) => new Set(ids.filter((id) => id !== accountId)),
    });
    return alerts.find((a) => a.kind === "sync_lag");
  };
  const seedMailbox = async (createdAgoMs: number) => {
    const accountId = randomUUID();
    seeded.push(accountId);
    await db.insert(accounts).values({ id: accountId, name: `progress-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `progress-${accountId.slice(0, 8)}@example.test`,
      status: "connected", createdAt: ago(createdAgoMs),
    }).returning();
    return { accountId, id: mb!.id };
  };
  const rowOf = async (id: string) => (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;

  it("THE CONTROL: a never-completed mailbox with no read pages from its creation", async () => {
    const mb = await seedMailbox(60 * MIN);
    const lag = await lagOf(mb.accountId);
    expect(lag, "an unread mailbox must look lagging, or the cases below are vacuous").toBeDefined();
    expect(lag!.count).toBe(1);
    expect(lag!.oldestSeconds).toBe(60 * 60);
  });

  it("a first import whose last cycle ended read_limited five minutes ago is alive", async () => {
    const mb = await seedMailbox(60 * MIN);
    expect(await markMailboxReadLimited(db, mb.id, { now: ago(5 * MIN) })).toBe(true);
    expect((await rowOf(mb.id)).syncProgressAt?.getTime()).toBe(ago(5 * MIN).getTime());
    expect((await lagOf(mb.accountId))?.count ?? 0, "a mailbox being read was paged as lagging").toBe(0);
  });

  it("the stamp MOVES with each read, so an import that keeps reading stays alive", async () => {
    const mb = await seedMailbox(90 * MIN);
    await markMailboxReadLimited(db, mb.id, { now: ago(50 * MIN) });
    await markMailboxReadLimited(db, mb.id, { now: ago(3 * MIN) });
    expect((await rowOf(mb.id)).syncProgressAt?.getTime()).toBe(ago(3 * MIN).getTime());
    expect((await lagOf(mb.accountId))?.count ?? 0).toBe(0);
  });

  it("an import that STOPS reading still pages, measured from its last read", async () => {
    const mb = await seedMailbox(90 * MIN);
    await markMailboxReadLimited(db, mb.id, { now: ago(45 * MIN) });
    const lag = await lagOf(mb.accountId);
    expect(lag, "progress turned the alert off").toBeDefined();
    expect(lag!.oldestSeconds).toBe(45 * 60);
  });

  it("after a completed cycle a ceiling stamps nothing, and last_sync_at decides", async () => {
    const mb = await seedMailbox(90 * MIN);
    await stampMailboxSync(db, [mb.id], ago(40 * MIN));
    await markMailboxReadLimited(db, mb.id, { now: ago(2 * MIN) });
    expect((await rowOf(mb.id)).syncProgressAt, "a ceiling after a completed cycle stamped progress").toBeNull();
    const lag = await lagOf(mb.accountId);
    expect(lag).toBeDefined();
    expect(lag!.oldestSeconds).toBe(40 * 60);
  });

  it("a completed cycle with a backlog moves the import's clock, and sync_lag still reads last_sync_at", async () => {
    const mb = await seedMailbox(90 * MIN);
    await stampMailboxSync(db, [mb.id], ago(40 * MIN));
    await stampImportProgress(db, mb.id, ago(2 * MIN));
    expect((await rowOf(mb.id)).syncProgressAt?.getTime()).toBe(ago(2 * MIN).getTime());
    const lag = await lagOf(mb.accountId);
    expect(lag, "the import's clock silenced the lag rule").toBeDefined();
    expect(lag!.oldestSeconds).toBe(40 * 60);
    await db.update(mailboxes).set({ initialImportCompletedAt: ago(1 * MIN) }).where(eq(mailboxes.id, mb.id));
    await stampImportProgress(db, mb.id, NOW);
    expect((await rowOf(mb.id)).syncProgressAt?.getTime(), "the clock moved past the stamp").toBe(ago(2 * MIN).getTime());
  });

  it("the failure arm's stamp keeps the same guard: once a cycle completed it writes nothing", async () => {
    const fresh = await seedMailbox(60 * MIN);
    expect(await stampSyncProgress(db, fresh.id, { now: ago(4 * MIN) })).toBe(true);
    expect((await lagOf(fresh.accountId))?.count ?? 0, "a first import being read paged").toBe(0);
    const synced = await seedMailbox(60 * MIN);
    await stampMailboxSync(db, [synced.id], ago(40 * MIN));
    expect(await stampSyncProgress(db, synced.id, { now: ago(1 * MIN) })).toBe(false);
    expect((await rowOf(synced.id)).syncProgressAt).toBeNull();
  });

  it("a provider's refusal is no read: a throttled first connect still pages", async () => {
    const mb = await seedMailbox(60 * MIN);
    expect(await markMailboxProviderUnavailable(db, mb.id, { now: ago(2 * MIN) })).toBe(true);
    const row = await rowOf(mb.id);
    expect(row.syncBlockedReason, "the real CHECK refused the new member").toBe("provider_unavailable");
    expect(row.syncProgressAt).toBeNull();
    expect((await lagOf(mb.accountId))?.count).toBe(1);
  });
});
