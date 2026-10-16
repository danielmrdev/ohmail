import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * MAIL 0055 APPLIED AND VERIFIED ON REAL POSTGRES — the column, its type, and the absence of a
 * backfill.
 *
 * PGlite cannot answer either of the two questions that matter here. The first is the TYPE: the
 * column is `bigint` and not `integer` because the value is an unbounded decimal in somebody
 * else's EHLO reply, and an announcement above 2^31 must be storable rather than raise 22003
 * inside the connect flow's transaction — which is a property of the server's numeric domain, not
 * of a driver. The second is that the migration RAN at all against the shared database: mail 0055's
 * `when` had to clear the highest `created_at` the target has ever seen, and a `when` that does not
 * is skipped silently and for ever (`packages/db-mail/drizzle/README.md`, step 2). A test that only
 * migrated a fresh in-process database could never see that.
 *
 * The third assertion is the census's refusal expressed as data: no PRODUCTION-SHAPED row may carry
 * a value this migration wrote. `smtp_max_size_bytes` means "the SERVER said so", and a backfill —
 * of our own 3 MB constant or of any real-world number — would turn a fallback the send path
 * recognises as ABSENT into a stored fact it cannot. It is scoped to addresses outside the RFC 2606
 * reserved `.test` TLD, for the reason written out at the assertion itself: this database is shared
 * with every other `*.pg.test.ts`, and a claim about production shape that other suites' fixtures
 * can falsify is a claim nobody can read.
 */
const PG_UP = await realPgAvailable();

const client = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
const db = brandDialect(drizzle(client), "pg");

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
});

afterAll(async () => {
  await client.end({ timeout: 5 }).catch(() => { /* the pool is already down */ });
});

describe.skipIf(!PG_UP)("mail 0055 — mailboxes.smtp_max_size_bytes on real Postgres", () => {
  it("the journal entry APPLIED — `when` cleared the target's maximum", async () => {
    const rows = await db.execute(sql`
      select created_at from drizzle_mail.__drizzle_migrations
      order by created_at desc limit 1
    `);
    // The entry's own `when`. If it had been chosen at or below the table's maximum the migrator
    // would have skipped it in silence and the column assertion below would be the only symptom —
    // reported as "the migration is broken" rather than "the timestamp is wrong".
    expect(Number((rows as unknown as Array<{ created_at: string }>)[0]!.created_at))
      .toBeGreaterThanOrEqual(1789340540527);
  });

  it("the column exists, is nullable, and is bigint", async () => {
    const rows = await db.execute(sql`
      select data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public' and table_name = 'mailboxes'
        and column_name = 'smtp_max_size_bytes'
    `);
    const found = rows as unknown as Array<{ data_type: string; is_nullable: string; column_default: string | null }>;
    expect(found, "mail 0055 did not apply — the column is absent").toHaveLength(1);
    expect(found[0]!.data_type).toBe("bigint");
    expect(found[0]!.is_nullable).toBe("YES");
    // NO DEFAULT. A default is a backfill that keeps happening: every mailbox connected afterwards
    // would carry a number no server said, on every row, for ever.
    expect(found[0]!.column_default).toBeNull();
  });

  it("holds a value above 2^31 — the reason it is bigint and not integer", async () => {
    // A value above `integer`'s range; on an `integer` column this statement raises 22003.
    // Written and read back through a temporary row, then deleted, so nothing is left behind.
    // Two statements rather than one data-modifying CTE: a CTE's `DELETE` reads the snapshot from
    // before the statement and cannot see what a sibling `INSERT` just wrote, so the round trip
    // would return no rows and look like a type failure.
    const written = await db.execute(sql`
      insert into mailboxes (account_id, provider, address, smtp_max_size_bytes)
      values (gen_random_uuid(), 'imap', concat('size-probe-', gen_random_uuid(), '@x.test'), 4294967296)
      returning id, smtp_max_size_bytes
    `);
    const row = (written as unknown as Array<{ id: string; smtp_max_size_bytes: string }>)[0]!;
    try {
      expect(Number(row.smtp_max_size_bytes)).toBe(4_294_967_296);
    } finally {
      await db.execute(sql`delete from mailboxes where id = ${row.id}::uuid`);
    }
  });

  it("NO BACKFILL — the migration wrote no value onto any PRODUCTION-SHAPED row", async () => {
    // A number on a production-shaped row means somebody appended an
    // `UPDATE mailboxes SET smtp_max_size_bytes = …` that the statement census in
    // `journal-split.test.ts` was meant to stop: `smtp_max_size_bytes` means "the SERVER said so",
    // and a backfill turns a fallback the send path recognises as ABSENT into a stored fact it
    // cannot.
    //
    // ── WHY THE PREDICATE IS `.test` AND NOT A LIST OF FIXTURE PREFIXES ─────────────────────
    //
    // This assertion is DATABASE-GLOBAL, and the shared :5433 Postgres is not this file's alone.
    // It was written with one exclusion — `size-probe-%`, this file's own temporary row — and went
    // permanently red the moment another suite legitimately wrote the column: 48 `n3-…@x.test`
    // mailboxes from `packages/services/test/send-staged-dedupe.pg.test.ts`, which needs a real
    // announced SIZE because that is the only ceiling a staged-only send has. A red that means
    // "somebody else ran a test" cannot also mean "the migration backfilled", and the one that
    // cries wolf is the one nobody reads.
    //
    // Naming each fixture prefix would make this a list every future test has to remember to
    // join. `.test` is the RFC 2606 §2 reserved TLD: **no deliverable address can end in it**, so
    // excluding those rows removes nothing this assertion was ever about. It is a narrowing to
    // production shape rather than a weakening — the claim is still "no real mailbox row carries a
    // value this migration could have written", over every row in the database, for ever, with no
    // maintenance. The fixture that leaked those rows now also cleans up after itself; this side
    // is what makes the guard correct even when a run dies before its `afterAll`, which is how the
    // stray `size-probe-…` row below survived.
    const rows = await db.execute(sql`
      select count(*)::int as n, min(address) as sample from mailboxes
      where smtp_max_size_bytes is not null and lower(address) not like '%.test'
    `);
    const found = (rows as unknown as Array<{ n: number; sample: string | null }>)[0]!;
    expect(found.n, `a real mailbox row carries a backfilled value, e.g. ${found.sample}`).toBe(0);
  });
});
