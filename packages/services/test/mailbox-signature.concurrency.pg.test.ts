import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { accountSettings, accounts, changeLog, mailboxes, accountSyncState } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { setMailboxFoldersEnabled, setMailboxSignature, mailboxSignatures } from "../src/consent-seed.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE SIGNATURE WRITE RACING ITS SIBLINGS, ON REAL POSTGRES — mail 0075.
 *
 * ── WHY `.pg.test.ts` ────────────────────────────────────────────────────────────────────
 *
 * `setMailboxSignature` takes the same three locks in the same order as
 * `setMailboxFoldersEnabled` — the `account_settings` row (the stamp move), the `mailboxes`
 * row, then the account's `account_sync_state` counter inside `recordChanges` — and the order
 * is the whole deadlock defence (the 40P01 cycle with erasure that the folders dial measured).
 * PGlite is one connection, so two `await`ed writers are sequential by construction and a test
 * there cannot see the interleaving; only real Postgres can prove the lock order composes.
 *
 * The properties: both columns hold exactly what their writers stored (neither transaction
 * clobbered the other's row), the change log has no seq hole and no duplicate (the counter
 * lock's promise), and nothing deadlocked (a 40P01 rejects the Promise.all and fails the test
 * by itself).
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ACCOUNT = randomUUID();
const NOW = new Date("2026-08-27T12:00:00.000Z");

const ctx = (): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId: ACCOUNT,
  userId: null,
  now: () => NOW,
  requestId: `sig-${randomUUID()}`,
} as ServiceContext);

describe.skipIf(!PG_UP)("mail 0075 — the signature write under real concurrency", () => {
  let mb1: string;
  let mb2: string;

  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);
    await db.insert(accounts).values({ id: ACCOUNT, name: `sg-${ACCOUNT.slice(0, 8)}` });
    const [a] = await db.insert(mailboxes)
      .values({ id: randomUUID(), accountId: ACCOUNT, provider: "imap", address: `one-${ACCOUNT.slice(0, 8)}@x.example` }).returning();
    const [b] = await db.insert(mailboxes)
      .values({ id: randomUUID(), accountId: ACCOUNT, provider: "imap", address: `two-${ACCOUNT.slice(0, 8)}@x.example` }).returning();
    mb1 = a!.id; mb2 = b!.id;
  });

  afterAll(async () => {
    await db.delete(changeLog).where(eq(changeLog.accountId, ACCOUNT));
    await db.delete(accountSyncState).where(eq(accountSyncState.accountId, ACCOUNT));
    await db.delete(accountSettings).where(eq(accountSettings.accountId, ACCOUNT));
    await db.delete(mailboxes).where(eq(mailboxes.accountId, ACCOUNT));
    await db.delete(accounts).where(eq(accounts.id, ACCOUNT));
    await client.end();
  });

  it("a signature write racing a folders flip AND a second signature: no deadlock, both columns exact, gap-free log", async () => {
    // Three writers genuinely in flight at once on separate pooled connections: two signature
    // writes on different mailboxes and the folders dial on one of them — every pair shares the
    // settings-stamp lock, and one pair shares a mailbox row too.
    await Promise.all([
      setMailboxSignature(ctx(), mb1, "— one\nohmail"),
      setMailboxSignature(ctx(), mb2, "— two"),
      setMailboxFoldersEnabled(ctx(), mb1, false),
    ]);

    // Columns: all three writers' stores landed — none clobbered another.
    const map = await mailboxSignatures(db as never, ACCOUNT);
    expect(map).toEqual({ [mb1]: "— one\nohmail", [mb2]: "— two" });
    const [mbRow] = await db.select({ at: mailboxes.foldersDisabledAt })
      .from(mailboxes).where(eq(mailboxes.id, mb1));
    expect(mbRow!.at).not.toBeNull();

    // The log: contiguous seqs, no duplicates — the counter lock's whole promise; and every
    // writer's doorbell is there (three settings rows).
    const rows = await db.select().from(changeLog)
      .where(eq(changeLog.accountId, ACCOUNT)).orderBy(changeLog.seq);
    const seqs = rows.map((r) => Number(r.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[seqs.length - 1]! - seqs[0]!).toBe(seqs.length - 1);
    expect(rows.filter((r) => r.entityType === "settings")).toHaveLength(3);
  });
});
