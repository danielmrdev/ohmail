import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { inArray, sql, eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { accounts } from "../src/schema-mail.js";
import { attachmentStaging } from "../src/schema-cloud.js";
import {
  createStagingTicketWithinQuota, outstandingStagingUsage, stagingObjectPath, stagingTicketId,
  DEFAULT_STAGING_QUOTA, ATTACHMENT_STAGING_TTL_MS,
  type StagingQuota,
} from "../src/attachment-staging.js";

/**
 * ═══ A DURABLE TICKET WITH A DURABLE KEY ═══════════════════════════════════════════════════
 *
 * ## The defect
 *
 * `POST /attachments/staging` wrote a durable row and handed back a grant to put bytes in a bucket
 * somebody pays for — under a RANDOM id. So a retry after a lost response minted a second row,
 * uploaded a second copy, and took a second helping of the per-account quota, and the client could
 * not tell the two apart: the only thing that ever named the first ticket was the response it did
 * not receive. A durable record whose KEY is not durable is the same defect as a send lock that
 * lives in the component that issued it.
 *
 * ## Why this file needs real Postgres
 *
 * The fix is a UNIQUENESS property — the ticket's primary key is the digest of the caller's
 * `Idempotency-Key` — and its two hard cases are both about more than one connection:
 *
 *  · **A RETRY FROM A DIFFERENT PROCESS.** The oracle is a second physical connection minting the
 *    same key and asking what the TABLE holds, which is the server-side twin of the client
 *    durability tests' "load a second store over the same disk". A single-connection PGlite proves
 *    nothing here: the interesting claim is about the row, not about a JS map.
 *  · **TWO SIMULTANEOUS MINTS OF ONE KEY.** That is what a double-tap or a client retrying a
 *    request whose response was lost actually looks like, and it needs two backends racing. PGlite
 *    has one.
 *
 * ## The mutations watched, each red then restored
 *
 *  · drop the replay lookup in `createStagingTicketWithinQuota` → the second mint raises a primary
 *    key violation instead of answering, so a retry becomes a 500;
 *  · derive the id from `randomUUID()` again → two rows, two objects, two helpings of quota;
 *  · leave the ACCOUNT out of `stagingTicketId`'s digest → one account's key names another's row;
 *  · answer an EXPIRED row as a replay → a grant is signed for bytes the sweep is deleting;
 *  · overwrite an expired row in place instead of refusing → the object it used to name is
 *    orphaned in the bucket for the life of the deployment.
 */
const PG_UP = await realPgAvailable();

// Several connections, because the decisive assertions are a second process and a real race.
const client = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const db = brandDialect(drizzle(client), "pg");

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
}, 120_000);

/** Every account this file creates — the :5433 database is SHARED and outlives the run. */
const created: string[] = [];

afterAll(async () => {
  if (PG_UP && created.length > 0) {
    await db.delete(attachmentStaging).where(inArray(attachmentStaging.accountId, created));
    await db.delete(accounts).where(inArray(accounts.id, created));
  }
  await client.end({ timeout: 5 }).catch(() => { /* the pool is already down */ });
});

const NOW = new Date("2026-08-31T12:00:00Z");

async function seedAccount(): Promise<string> {
  const rows = await db.execute(sql`
    insert into accounts (name) values ('staging-idempotency-pg') returning id
  `);
  const id = (rows as unknown as Array<{ id: string }>)[0]!.id;
  created.push(id);
  return id;
}

/**
 * ONE MINT, composed exactly as `makeAttachmentStagingPort` composes it: the id is the key's
 * digest and the object path is derived from the id. Composing it here rather than importing the
 * port keeps this file inside `packages/db`, where the uniqueness property lives — and the
 * composition itself is asserted below rather than assumed.
 */
function mint(
  accountId: string,
  key: string,
  over: { sizeBytes?: number; now?: Date; filename?: string; quota?: StagingQuota } = {},
) {
  const id = stagingTicketId(accountId, key);
  return db.transaction((tx) => createStagingTicketWithinQuota(tx as never, {
    id,
    accountId,
    objectPath: stagingObjectPath(accountId, id),
    filename: over.filename ?? "holiday.mov",
    contentType: "video/quicktime",
    sizeBytes: over.sizeBytes ?? 1024,
    now: over.now ?? NOW,
  }, over.quota ?? DEFAULT_STAGING_QUOTA));
}

const rowsFor = (accountId: string) =>
  db.select().from(attachmentStaging).where(eq(attachmentStaging.accountId, accountId));

describe("the ticket id IS the idempotency key", () => {
  it("is a well-formed uuid, deterministic, and scoped to the account", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    const id = stagingTicketId(a, "send-1:att:0");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stagingTicketId(a, "send-1:att:0")).toBe(id);
    // THE ACCOUNT IS IN THE DIGEST. Reads are account-scoped too, and both are wanted: the
    // scoping is what refuses, this is what makes a collision unconstructible.
    expect(stagingTicketId(b, "send-1:att:0")).not.toBe(id);
    // Two attachments of one send are two tickets — the index in the key is what does that.
    expect(stagingTicketId(a, "send-1:att:1")).not.toBe(id);
  });
});

describe.skipIf(!PG_UP)("a retry under the same key gets the SAME ticket", () => {
  /**
   * THE REGRESSION. The second mint is the retry a lost response causes, and the oracle is the
   * TABLE — what a third party looking at the database sees, not what either caller believes.
   */
  it("one row, one object path, and the quota is charged once", async () => {
    const accountId = await seedAccount();
    const key = "send-abc:att:0";

    const first = await mint(accountId, key, { sizeBytes: 5_000 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.replayed).toBe(false);

    // The response was lost. The client tries again with the same key.
    const second = await mint(accountId, key, { sizeBytes: 5_000 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.replayed, "the retry minted a NEW ticket").toBe(true);
    expect(second.ticket.id).toBe(first.ticket.id);
    // THE OBJECT PATH IS THE HALF THAT COSTS MONEY: same path ⇒ the retry's bytes overwrite the
    // first attempt's rather than becoming a second object nothing will ever read.
    expect(second.ticket.objectPath).toBe(first.ticket.objectPath);

    const rows = await rowsFor(accountId);
    expect(rows, "the retry wrote a second row").toHaveLength(1);
    const usage = await outstandingStagingUsage(db as never, accountId, NOW);
    expect(usage).toEqual({ tickets: 1, bytes: 5_000 });
  });

  /**
   * A RETRY AT THE QUOTA CEILING IS STILL SERVED. The replay is answered BEFORE the quota is even
   * read, which is the only correct order: an account that filled its allowance and then lost one
   * response would otherwise be refused its own ticket back and could never finish the send.
   *
   * WATCHED RED by moving the replay lookup below the quota check.
   */
  it("is answered even when the account is at its ceiling", async () => {
    const accountId = await seedAccount();
    const tight: StagingQuota = { maxTickets: 2, maxBytes: 10_000 };
    const a = await mint(accountId, "s:att:0", { sizeBytes: 1_000, quota: tight });
    const b = await mint(accountId, "s:att:1", { sizeBytes: 1_000, quota: tight });
    expect(a.ok && b.ok).toBe(true);
    // Full: a THIRD key is refused.
    const third = await mint(accountId, "s:att:2", { sizeBytes: 1_000, quota: tight });
    expect(third.ok).toBe(false);
    // …and the retry of the first is not.
    const retry = await mint(accountId, "s:att:0", { sizeBytes: 1_000, quota: tight });
    expect(retry.ok).toBe(true);
    if (!retry.ok || !a.ok) return;
    expect(retry.ticket.id).toBe(a.ticket.id);
    expect(await rowsFor(accountId)).toHaveLength(2);
  });

  /**
   * TWO SIMULTANEOUS MINTS OF ONE KEY — the double-tap, on two backends.
   *
   * The per-account advisory lock the quota already takes is what makes this an ANSWER rather than
   * a constraint violation: the loser waits, then finds the winner's row and replays it. Without
   * the lock the primary key would still refuse the duplicate, but the caller would get a 500 for
   * a request that has already succeeded.
   *
   * WATCHED RED by removing the replay lookup: one of the two rejects with
   * `duplicate key value violates unique constraint "attachment_staging_pkey"`.
   */
  it("a concurrent double-tap answers twice and writes once", async () => {
    const accountId = await seedAccount();
    const key = "double-tap:att:0";
    const [x, y] = await Promise.all([
      mint(accountId, key, { sizeBytes: 2_048 }),
      mint(accountId, key, { sizeBytes: 2_048 }),
    ]);
    expect(x.ok).toBe(true);
    expect(y.ok).toBe(true);
    if (!x.ok || !y.ok) return;
    expect(x.ticket.id).toBe(y.ticket.id);
    // Exactly one of the two minted; the other replayed.
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
    expect(await rowsFor(accountId)).toHaveLength(1);
  });

  /** The vacuity guard: an implementation that replayed EVERYTHING would pass every case above. */
  it("different keys are still different tickets", async () => {
    const accountId = await seedAccount();
    const a = await mint(accountId, "send-1:att:0", { sizeBytes: 1_000 });
    const b = await mint(accountId, "send-1:att:1", { sizeBytes: 1_000 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.ticket.id).not.toBe(b.ticket.id);
    expect(a.ticket.objectPath).not.toBe(b.ticket.objectPath);
    expect(await rowsFor(accountId)).toHaveLength(2);
  });

  /** One account's key can never reach another's row. */
  it("the same key under two accounts is two tickets", async () => {
    const one = await seedAccount();
    const two = await seedAccount();
    const a = await mint(one, "shared-key:att:0");
    const b = await mint(two, "shared-key:att:0");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.ticket.id).not.toBe(b.ticket.id);
    expect(await rowsFor(one)).toHaveLength(1);
    expect(await rowsFor(two)).toHaveLength(1);
  });
});

describe.skipIf(!PG_UP)("a key whose ticket has aged out is refused, not reused", () => {
  /**
   * THE FAILURE THIS COULD HAVE OPENED, and it is the reason the branch is a refusal rather than
   * a re-mint.
   *
   * A row past `expires_at` is still here only because the sweep has not reached it, and the sweep
   * deletes the OBJECT first. So:
   *
   *  · replaying it would sign a grant for bytes on their way out — the client uploads, the sweep
   *    deletes, and the send fails with the file missing;
   *  · overwriting the row in place would leave the object it currently names with nothing
   *    pointing at it, which is the one leak this module's ordering exists to prevent: an object
   *    whose row is gone lives in the bucket for the life of the deployment.
   *
   * Refusing is temporary and self-healing — one sweep later the id is free — and it is 24 hours
   * late by construction, because the ticket's TTL and the send's idempotency window are the same
   * 24 hours. Nothing that could still be a retry can reach it.
   */
  it("answers `expired` and leaves the row exactly as it was", async () => {
    const accountId = await seedAccount();
    const key = "old-send:att:0";
    const minted = await mint(accountId, key, { sizeBytes: 3_000 });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const later = new Date(NOW.getTime() + ATTACHMENT_STAGING_TTL_MS + 60_000);
    const again = await mint(accountId, key, { sizeBytes: 3_000, now: later, filename: "new.mov" });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe("expired");

    const [row] = await db.select().from(attachmentStaging)
      .where(and(
        eq(attachmentStaging.accountId, accountId),
        eq(attachmentStaging.id, minted.ticket.id),
      ));
    expect(row, "the expired row was deleted or replaced — its object is now orphaned").toBeDefined();
    expect(row!.objectPath).toBe(minted.ticket.objectPath);
    expect(row!.filename).toBe("holiday.mov");
    expect(await rowsFor(accountId)).toHaveLength(1);
  });
});
