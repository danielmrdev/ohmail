import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * THE AUTHENTICATION LOOKUP MUST NOT BE A SEQUENTIAL SCAN.
 *
 * `resolveSession` runs on every authenticated request and matches `sessions.access_token_hash`.
 * That column had no index — read off live production `pg_indexes`, then confirmed by asking the
 * production planner, which answered `Seq Scan on sessions`. It went unnoticed because the table
 * was small, and it matters because the table only grows: sessions are
 * MARKED revoked and never physically reaped, so the scan's width is every session the deployment
 * has ever minted, and any signed-in caller can widen it at request rate for everybody else.
 *
 * THIS TESTS THE PROPERTY, NOT THE DDL. Asserting `sessions_access_token_hash_idx` exists in
 * `pg_indexes` would pass over an index the planner refuses to use, and would fail over a
 * differently-named index that serves the query perfectly. What has to hold is that the real
 * predicate gets a real index scan, so that is what is asserted — against the migrated schema, on
 * real Postgres, because a plan is not a property PGlite can answer for.
 *
 * ── THE SUBJECT IS A GROWN TABLE, AND IT USED NOT TO BE ─────────────────────────────────────
 *
 * The first version of this file asked the question against whatever `sessions` happened to hold,
 * which on a test database is nothing, and an empty table cannot answer it: scanning zero pages is
 * genuinely cheaper than any index, so `Seq Scan` is the CORRECT plan there and the guard's
 * verdict is about statistics rather than about the index. Measured on 2026-09-12, both readings
 * on the same empty table: with no statistics at all (`reltuples = -1`) the planner falls back to
 * a ten-page estimate and answers `Bitmap Index Scan`, which is how this file was passing; one
 * `ANALYZE` later it answers `Seq Scan`. So the file was green while nothing had analysed the
 * table and red the moment anything had — which is what a run beside thirty-four co-tenants did
 * to it, with the index present and perfect the whole time.
 *
 * So the table is GROWN FIRST, with this run's own rows, and analysed before the planner is asked.
 * Everything happens inside ONE transaction that is rolled back: the rows never outlive the case,
 * nothing else's data is read or touched, and a co-tenant's rows can only make the index MORE
 * attractive, never less. The two readings are taken inside that transaction and asserted after
 * it, so an assertion failure is never confused with the deliberate rollback.
 *
 * THE CONTROL RUNS EVERY TIME rather than by hand: the same predicate is planned again with the
 * index dropped inside the same transaction, and must come back `Seq Scan`. A green that cannot
 * be made red is not evidence, and this one is made red on every run.
 */
const PG_UP = await realPgAvailable();
const client = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });

/** The sentinel that ends the transaction. Any other error is a real failure and is rethrown. */
const ROLLBACK = "session-lookup-index: rolled back on purpose";

/** Enough rows that a sequential scan is the expensive answer; ~130 pages, seeded in one insert. */
const GROWN_ROWS = 5_000;

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => {
  // The rows rolled back, but ANALYZE writes `pg_class.reltuples` outside the transaction, so the
  // table would be left claiming thousands of rows it no longer has. Put the truth back before leaving.
  if (PG_UP) { try { await client`analyze sessions`; } catch { /* the verdict is already in */ } }
  await client.end({ timeout: 5 });
});

describe.skipIf(!PG_UP)("sessions.access_token_hash — the per-request auth lookup", () => {
  it("plans as an index scan on a grown table, and a sequential one without the index", async () => {
    // `enable_seqscan` is left ALONE deliberately. Forcing it off would make any index look used
    // and turn this guard into a tautology; the question is what the planner picks unaided.
    const nodesOf = async (sql: postgres.TransactionSql): Promise<string> => {
      const rows = await sql`
        explain (format json)
        select 1 from sessions
        where access_token_hash = 'not-a-real-hash'
          and revoked_at is null
          and access_expires_at > now()
        limit 1`;
      return (JSON.stringify(rows[0]).match(/"Node Type":"([^"]+)"/g) ?? []).join(" > ");
    };

    let withIndex = "";
    let withoutIndex = "";
    let grown = 0;
    try {
      await client.begin(async (sql) => {
        const [account] = await sql`insert into accounts default values returning id`;
        const [user] = await sql`
          insert into users (account_id, email)
          values (${account!.id}, ${`session-lookup-index-${crypto.randomUUID()}@test.invalid`})
          returning id`;
        await sql`
          insert into sessions
            (account_id, user_id, family_id, access_token_hash, access_expires_at, refresh_expires_at)
          select ${account!.id}::uuid, ${user!.id}::uuid, gen_random_uuid(),
                 encode(sha256(g::text::bytea), 'hex'),
                 now() + interval '1 hour', now() + interval '30 days'
          from generate_series(1, ${GROWN_ROWS}) g`;
        await sql`analyze sessions`;
        const [stat] = await sql`select reltuples::bigint as n from pg_class where relname = 'sessions'`;
        grown = Number(stat!.n);

        withIndex = await nodesOf(sql);
        // THE CONTROL, on the same rows and the same predicate: without the index the plan the
        // production defect produced is the plan that comes back.
        await sql`drop index sessions_access_token_hash_idx`;
        withoutIndex = await nodesOf(sql);
        throw new Error(ROLLBACK);
      });
      throw new Error("the transaction committed — the seeded sessions are still in the table");
    } catch (e) {
      if (!(e instanceof Error) || e.message !== ROLLBACK) throw e;
    }

    expect(grown, "the planner was asked about a table that had not grown").toBeGreaterThanOrEqual(GROWN_ROWS);
    expect(withIndex,
      "every authenticated request runs this; a Seq Scan here costs every user the whole session history")
      .toContain("Index Scan");
    expect(withIndex).not.toContain("Seq Scan");
    expect(withoutIndex, "the guard cannot be made red — drop the index and the plan did not change")
      .toContain("Seq Scan");

    // The rollback really did undo both halves: no rows of this run survive, and the index the
    // control dropped is back. A leak of either would reach every other lane on this cluster.
    const [rows] = await client`
      select count(*)::int as n from sessions where access_token_hash like ${"%"} and revoked_at is null
        and access_expires_at > now() + interval '59 minutes'`;
    expect(rows!.n, "this run's seeded sessions outlived the transaction").toBe(0);
    const [index] = await client`
      select count(*)::int as n from pg_indexes where indexname = 'sessions_access_token_hash_idx'`;
    expect(index!.n, "the control's DROP INDEX escaped the transaction").toBe(1);
  }, 120_000);
});
