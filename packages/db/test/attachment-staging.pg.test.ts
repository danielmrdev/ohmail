import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { accounts } from "../src/schema-mail.js";
import { attachmentStaging } from "../src/schema-cloud.js";
import {
  createStagingTicket, readStagingTickets, expiredStagingTickets, deleteStagingTickets,
  sweepExpiredStaging, ATTACHMENT_STAGING_TTL_MS,
} from "../src/attachment-staging.js";

/**
 * CLOUD 0015 APPLIED AND VERIFIED ON REAL POSTGRES — and the retention sweep run end to end.
 *
 * ## What PGlite cannot answer here, and this can
 *
 *  · **THE MIGRATION RAN AT ALL against the shared database.** A cloud entry's `when` has to clear
 *    the highest `created_at` the target has ever seen; one that does not is skipped SILENTLY and
 *    for ever, and a test that only migrated a fresh in-process database could never see it. That
 *    is the first assertion, and it is the one that has bitten this journal before.
 *  · **THE TYPE of `size_bytes`.** It is `bigint` because a declared size is somebody else's
 *    number and an announcement above 2^31 must be storable rather than raise 22003 inside the
 *    mint's transaction — a property of the server's numeric domain, not of a driver. The read
 *    hands it back as a JavaScript `number` (mode: "number"), which matters because the send ADDS
 *    these up to refuse an over-cap total, and string concatenation would be a silent pass.
 *  · **THE UNIQUE object path** under a real constraint, raising a real 23505.
 *
 * ## The sweep, including the trap
 *
 * The abandoned upload is the injected-default trap this file exists for: a ticket minted, a
 * compose window closed, no object ever written. `remove` treats a storage 404 as SUCCESS
 * precisely so that row clears — a sweep that read the 404 as a failure would keep every abandoned
 * ticket for the life of the deployment while reporting nothing. Here that path is driven with a
 * storage port that throws nothing and deletes nothing, which is exactly what a 404 looks like from
 * the sweep's side, and the assertion is that the ROW is gone and the unexpired ones are not.
 */
const PG_UP = await realPgAvailable();

const client = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
const db = brandDialect(drizzle(client), "pg");

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
});

/**
 * EVERY ACCOUNT THIS FILE CREATES, so it can take them away again.
 *
 * The :5433 Postgres is SHARED and long-lived, and this file had been leaving its throwaway
 * accounts and their tickets in it on every run. Nothing was failing over it — these accounts carry
 * no mailbox, so the database-global assertions elsewhere could not see them — but the identical
 * habit in `packages/services/test/send-staged-dedupe.pg.test.ts` DID turn
 * `mailbox-smtp-max-size.pg.test.ts` permanently red, and "no assertion happens to look at my rows
 * yet" is not a property worth relying on.
 */
const created: string[] = [];

afterAll(async () => {
  if (PG_UP && created.length > 0) {
    // Child rows first — `attachment_staging.account_id` carries a foreign key. Through drizzle's
    // `inArray` rather than a `= any(${ids})` template: drizzle expands a JS array in a `sql`
    // template as a ROW constructor, and the cast then reads `cannot cast type record to uuid[]`.
    await db.delete(attachmentStaging).where(inArray(attachmentStaging.accountId, created));
    await db.delete(accounts).where(inArray(accounts.id, created));
  }
  await client.end({ timeout: 5 }).catch(() => { /* the pool is already down */ });
});

/** A throwaway account, so parallel rows in a shared database never collide. */
async function seedAccount(): Promise<string> {
  const rows = await db.execute(sql`
    insert into accounts (name) values ('staging-pg') returning id
  `);
  const id = (rows as unknown as Array<{ id: string }>)[0]!.id;
  created.push(id);       // see `afterAll` — this database outlives the run
  return id;
}

const NOW = new Date("2026-08-13T12:00:00Z");
const mint = (
  accountId: string,
  over: {
    now?: Date; sizeBytes?: number; objectPath?: string; contentSha256?: string | null;
  } = {},
) => {
  const id = randomUUID();
  return createStagingTicket(db as never, {
    id,
    accountId,
    objectPath: over.objectPath ?? `${accountId}/${id}`,
    filename: "holiday.mov",
    contentType: "video/quicktime",
    sizeBytes: over.sizeBytes ?? 6 * 1024 * 1024,
    contentSha256: over.contentSha256 ?? null,
    now: over.now ?? NOW,
  });
};

describe.skipIf(!PG_UP)("cloud 0015 — attachment_staging on real Postgres", () => {
  it("the journal entry APPLIED — `when` cleared the target's maximum", async () => {
    const rows = await db.execute(sql`
      select created_at from drizzle_cloud.__drizzle_migrations
      order by created_at desc limit 1
    `);
    // The entry's own `when`. Chosen at or below the table's maximum, the migrator would have
    // skipped it in silence and the table assertion below would be the only symptom — reported as
    // "the migration is broken" rather than "the timestamp is wrong".
    expect(Number((rows as unknown as Array<{ created_at: string }>)[0]!.created_at))
      .toBeGreaterThanOrEqual(1789858940527);
  });

  it("`size_bytes` is bigint, not integer — a declared size is somebody else's number", async () => {
    const rows = await db.execute(sql`
      select data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'attachment_staging'
        and column_name = 'size_bytes'
    `);
    const found = rows as unknown as Array<{ data_type: string; is_nullable: string }>;
    expect(found).toHaveLength(1);
    expect(found[0]!.data_type).toBe("bigint");
    expect(found[0]!.is_nullable).toBe("NO");
  });

  it("a value above 2^31 round-trips as a NUMBER the send can add up", async () => {
    const accountId = await seedAccount();
    const big = 3 * 1024 * 1024 * 1024;   // 3 GiB — an `integer` column would raise 22003
    const row = await mint(accountId, { sizeBytes: big });
    const [read] = await readStagingTickets(db as never, accountId, [row.id]);
    expect(read!.sizeBytes).toBe(big);
    expect(typeof read!.sizeBytes).toBe("number");
  });

  it("TWO ROWS MAY NOT NAME ONE OBJECT — a real 23505 from the real constraint", async () => {
    const accountId = await seedAccount();
    const path = `${accountId}/collide`;
    await mint(accountId, { objectPath: path });
    await expect(mint(accountId, { objectPath: path })).rejects.toThrow(/duplicate key|23505/);
  });

  /**
   * CLOUD 0041 — content identity. Three facts only a real server can answer: the column exists
   * on the SHARED database (so the entry's `when` cleared its maximum), a stated digest survives
   * the round trip as a string the send can compare, and the CHECK is a real constraint rather
   * than a comment — a malformed digest is refused by the database, not merely by the route.
   */
  it("`content_sha256` is a nullable text column the read hands back", async () => {
    const accountId = await seedAccount();
    const digest = "a".repeat(64);
    const row = await mint(accountId, { contentSha256: digest });
    expect(row.contentSha256).toBe(digest);
    const [read] = await readStagingTickets(db as never, accountId, [row.id]);
    expect(read!.contentSha256).toBe(digest);

    // AND A TICKET THAT STATED NOTHING reads back as null, never as undefined: the send tells
    // "no declaration" from "these bytes", and both states have to arrive.
    const bare = await mint(accountId);
    const [readBare] = await readStagingTickets(db as never, accountId, [bare.id]);
    expect(readBare!.contentSha256).toBeNull();
  });

  it("the CHECK refuses a digest that is not 64 lowercase hex", async () => {
    // Added NOT VALID by 0041 — a growth table takes no validating scan inside the migrator's one
    // transaction — and VALIDATED by cloud 0045 one release later, so the catalog now says every
    // row holds. Enforced for every write either way, which the two inserts below measure.
    const con = await db.execute(sql`
      select convalidated from pg_constraint where conname = 'attachment_staging_content_sha256_hex'
    `);
    expect((con as unknown as Array<{ convalidated: boolean }>).map((r) => r.convalidated))
      .toEqual([true]);
    const accountId = await seedAccount();
    await expect(mint(accountId, { contentSha256: "A".repeat(64) }))
      .rejects.toThrow(/attachment_staging_content_sha256_hex|23514/);
    await expect(mint(accountId, { contentSha256: "abc" }))
      .rejects.toThrow(/attachment_staging_content_sha256_hex|23514/);
  });

  it("a foreign account's ticket is not readable, even by its own id", async () => {
    const mine = await seedAccount();
    const theirs = await seedAccount();
    const t = await mint(theirs);
    expect(await readStagingTickets(db as never, mine, [t.id])).toEqual([]);
  });
});

describe.skipIf(!PG_UP)("the retention sweep, against real Postgres", () => {
  /**
   * The sweep composed exactly as the worker composes it, with an injected storage port.
   *
   * A STATIC IMPORT from this package's own source, and that is the point of the seam: this used
   * to be `await import("@trafficflow/services")`, a db-package test reaching up a layer for the
   * pass that deletes rows this package owns — the same reach `apps/worker/src/index.ts` was
   * making, one boundary further along, where it cost a deploy. The sweep is here now.
   */
  async function sweep(storage: { removed: string[][]; fail?: boolean }, now: Date, limit = 200) {
    return sweepExpiredStaging({
      storage: {
        async signUpload() { throw new Error("unused"); },
        async download() { throw new Error("unused"); },
        async remove(paths) {
          if (storage.fail) throw new Error("storage is down");
          storage.removed.push([...paths]);
        },
      },
      expired: (n) => expiredStagingTickets(db as never, now, n),
      deleteRows: (ids) => deleteStagingTickets(db as never, ids),
      limit,
    });
  }

  it("EXPIRED ROWS AND THEIR OBJECTS GO; UNEXPIRED ONES SURVIVE", async () => {
    const accountId = await seedAccount();
    const expired = await mint(accountId, {
      now: new Date(NOW.getTime() - ATTACHMENT_STAGING_TTL_MS - 60_000),
    });
    const live = await mint(accountId, { now: NOW });

    const storage = { removed: [] as string[][] };
    const gone = await sweep(storage, NOW);
    expect(gone).toBeGreaterThanOrEqual(1);
    expect(storage.removed.flat()).toContain(expired.objectPath);
    expect(storage.removed.flat()).not.toContain(live.objectPath);

    const left = await readStagingTickets(db as never, accountId, [expired.id, live.id]);
    expect(left.map((r) => r.id)).toEqual([live.id]);
  });

  it("THE ABANDONED UPLOAD CLEARS — a ticket whose object never existed", async () => {
    // The injected-default trap. `remove` treats a storage 404 as success, so this is what an
    // upload that never happened looks like from the sweep's side: the object delete is a no-op
    // and the ROW still has to go. A sweep that read the 404 as a failure would keep this row for
    // the life of the deployment while reporting a clean number.
    const accountId = await seedAccount();
    const ghost = await mint(accountId, {
      now: new Date(NOW.getTime() - 2 * ATTACHMENT_STAGING_TTL_MS),
    });
    const storage = { removed: [] as string[][] };
    await sweep(storage, NOW);
    expect(await readStagingTickets(db as never, accountId, [ghost.id])).toEqual([]);
  });

  it("a STORAGE FAILURE leaves the rows for the next pass — never a row without its object", async () => {
    const accountId = await seedAccount();
    const doomed = await mint(accountId, {
      now: new Date(NOW.getTime() - 2 * ATTACHMENT_STAGING_TTL_MS),
    });
    const storage = { removed: [] as string[][], fail: true };
    await expect(sweep(storage, NOW)).rejects.toThrow(/storage is down/);
    // The row survived, which is the recoverable direction: the next hour retries. Deleting it
    // first would have made its object unreachable and permanent.
    const left = await readStagingTickets(db as never, accountId, [doomed.id]);
    expect(left).toHaveLength(1);
  });

  it("the batch bound is honoured — what one pass leaves, the next takes", async () => {
    // THE SWEEP IS GLOBAL, not account-scoped: its predicate is the clock, and it is the elected
    // writer's pass over the whole table. So this drains whatever earlier cases left behind before
    // measuring — without it the bounded pass picks the oldest row in the DATABASE, which on a
    // shared Postgres is somebody else's, and the assertion reads as a bound that does not hold.
    const drain = { removed: [] as string[][] };
    while (await sweep(drain, NOW, 500) > 0) { /* until the expired set is empty */ }

    const accountId = await seedAccount();
    const old = new Date(NOW.getTime() - 2 * ATTACHMENT_STAGING_TTL_MS);
    const a = await mint(accountId, { now: old });
    const b = await mint(accountId, { now: new Date(old.getTime() + 1000) });
    const storage = { removed: [] as string[][] };
    expect(await sweep(storage, NOW, 1)).toBe(1);
    // OLDEST FIRST — `a` was minted a second earlier, so it is the one that went.
    const after = await readStagingTickets(db as never, accountId, [a.id, b.id]);
    expect(after.map((r) => r.id)).toEqual([b.id]);
    expect(await sweep(storage, NOW, 1)).toBe(1);
    expect(await readStagingTickets(db as never, accountId, [a.id, b.id])).toEqual([]);
  });
});
