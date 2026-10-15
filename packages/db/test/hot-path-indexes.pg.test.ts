import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/migrate.js";
import {
  ensureHotPathIndexes, HOT_PATH_INDEXES, HOT_PATH_INDEX_SPECS,
} from "../src/hot-path-indexes.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * The hot-path indexes, against real Postgres — the only place this can be tested at all.
 * `CREATE INDEX CONCURRENTLY` is refused inside a transaction (`25001`), which is exactly why
 * these are not journal statements, and PGlite has neither the concurrency nor the `pg_index`
 * catalog writes the invalid-leftover case needs.
 *
 * The shapes are the contract: a plain DROP on the retry path re-takes the table lock the
 * concurrent build exists to avoid, an unheld advisory lock races a sibling replica's live build,
 * and an unqualified ON clause could land an index on a stranger's table.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof brandDialect<ReturnType<typeof drizzle>>>;

const validOf = async (name: string): Promise<boolean | null> => {
  const rows = await client`
    select i.indisvalid as valid from pg_class c
      join pg_index i on i.indexrelid = c.oid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = ${name}`;
  return (rows[0]?.valid as boolean | undefined) ?? null;
};

describe.skipIf(!PG_UP)("hot-path indexes (real Postgres)", () => {
  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(client), "pg");
    await runMigrations(PG_TEST_URL);
  }, 180_000);

  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("builds every unconditional index, valid, and a second call is a no-op", async () => {
    for (const n of HOT_PATH_INDEXES) await client.unsafe(`drop index if exists public."${n}"`);
    for (const n of HOT_PATH_INDEXES) expect(await validOf(n), n).toBe(null);

    await ensureHotPathIndexes(db);
    for (const n of HOT_PATH_INDEXES) expect(await validOf(n), n).toBe(true);

    // Idempotent: the ordinary re-run of a provisioning command.
    await ensureHotPathIndexes(db);
    for (const n of HOT_PATH_INDEXES) {
      const rows = await client`
        select count(*)::int as n from pg_class c join pg_namespace s on s.oid = c.relnamespace
         where s.nspname = 'public' and c.relname = ${n}`;
      expect(rows[0]!.n, `${n} was built twice`).toBe(1);
    }
  }, 180_000);

  it("an INVALID leftover is dropped and rebuilt, not read as present", async () => {
    // A failed CONCURRENTLY build leaves an invalid index that `IF NOT EXISTS` treats as
    // present — permanently broken, and the planner refuses to use it. Forge that state.
    await ensureHotPathIndexes(db);
    const name = HOT_PATH_INDEXES[0];
    await client.unsafe(
      `update pg_index set indisvalid = false where indexrelid = 'public."${name}"'::regclass`);
    expect(await validOf(name)).toBe(false);

    await ensureHotPathIndexes(db);
    expect(await validOf(name), "an INVALID leftover was kept as 'present'").toBe(true);
  }, 180_000);

  it("the index actually serves the eviction order — the plan stops sorting", async () => {
    // The reason this index exists, asserted rather than assumed: the victim read orders by
    // `coalesce(date, created_at), id` within one account and no other index offers that order.
    // A name-only assertion would pass for an index the planner never uses.
    // ROWS FIRST. On an empty table the planner sorts whatever indexes exist, so the version of
    // this case without a fixture asserted something about the fixture and nothing about the
    // index — it read `Limit -> Sort` with the index present and correct.
    const acct = randomUUID();
    const [mb] = await client`
      insert into mailboxes ("account_id","provider","address")
      values (${acct}, 'imap', ${`plan-${acct}@tf.example`}) returning "id"`;
    await client.unsafe(`
      insert into messages ("account_id","mailbox_id","body_hash","dedup_key","from_address","date")
      select $1::uuid, $2::uuid, 'h', 'plan:' || $1 || ':' || g,
             'anna@x.example', now() - (g || ' minutes')::interval
        from generate_series(1, 20000) g`, [acct, mb!.id as string]);

    await ensureHotPathIndexes(db);
    await client.unsafe(`analyze messages`);
    const q = `explain (costs off) select m."id" from messages m
                where m."account_id" = '${acct}'::uuid
                order by coalesce(m."date", m."created_at") asc, m."id" asc limit 200`;
    const withIx = (await client.unsafe(q)).map((r) => String(r["QUERY PLAN"])).join("\n");

    await client.unsafe(`drop index public."messages_account_date_order_idx"`);
    await client.unsafe(`analyze messages`);
    const without = (await client.unsafe(q)).map((r) => String(r["QUERY PLAN"])).join("\n");
    await ensureHotPathIndexes(db);   // put it back for the rest of the file

    // The discriminator is the pair, not either plan alone: an empty table can be planned either
    // way, so the claim is that the index CHANGES the plan in the direction it was built for.
    expect(without, "without the index the planner had no reason to sort differently")
      .toMatch(/Sort/);
    expect(withIx).toContain("messages_account_date_order_idx");
    expect(withIx, "the index is used and the sort is gone").not.toMatch(/Sort/);

    await client.unsafe(`delete from messages where "account_id" = $1::uuid`, [acct]);
    await client.unsafe(`delete from mailboxes where "account_id" = $1::uuid`, [acct]);
  }, 300_000);

  it("skips a table that does not exist yet instead of aborting the setup", async () => {
    // The setup runs this after the migrator, so both tables exist — but a database at a partial
    // migration position must not have its provisioning aborted by a helper written to speed it
    // up. Driven through the statement-runner seam, because the real database has the tables.
    const ran: string[] = [];
    const said: string[] = [];
    const fake = {
      execute: async (q: unknown) => {
        const text = JSON.stringify(
          (q as { queryChunks?: unknown }).queryChunks ?? q,
          (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v),
        );
        ran.push(text);
        if (text.includes("information_schema.tables")) return [{ present: false }];
        return [];
      },
    };
    await ensureHotPathIndexes(fake, { log: (m) => said.push(m) });
    const joined = ran.join("\n");
    expect(joined).not.toContain("create index concurrently");
    // THE LOCK IS NEVER LEFT HELD, and on this path it is never TAKEN: admission runs ahead of
    // the acquisition, so a database with none of the tables serializes nothing. Asserted as the
    // pairing rather than as "an unlock appears", which a helper that took two and released one
    // would also satisfy.
    const count = (needle: string): number => ran.filter((t) => t.includes(needle)).length;
    expect(count("pg_advisory_lock")).toBe(count("pg_advisory_unlock"));
    expect(count("pg_advisory_lock")).toBe(0);
    // One skip per SPEC, not per unconditional name: the deferred spec is skipped here too, for
    // the missing table rather than for its size.
    expect(said.filter((m) => m.includes("does not exist yet")))
      .toHaveLength(HOT_PATH_INDEX_SPECS.length);
  });

  it("statement shapes: under the lock, CONCURRENTLY both ways, pinned to public, bound lifted before DDL", async () => {
    const ran: string[] = [];
    const fake = {
      execute: async (q: unknown) => {
        const text = JSON.stringify(
          (q as { queryChunks?: unknown }).queryChunks ?? q,
          (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v),
        );
        ran.push(text);
        if (text.includes("information_schema.tables")) return [{ present: true }];
        if (text.includes("indisvalid")) return [{ valid: false }];   // force the rebuild arm
        return [];
      },
    };
    await ensureHotPathIndexes(fake);
    const joined = ran.join("\n");
    const at = (needle: string): number => ran.findIndex((s) => s.includes(needle));

    expect(joined).toContain("pg_advisory_lock");
    expect(joined).toContain("pg_advisory_unlock");
    expect(joined).toContain("drop index concurrently if exists");
    expect(joined).toContain("create index concurrently if not exists");
    expect(joined).toContain("on public.audit_log");
    expect(joined).toContain("on public.messages");
    // Every DROP is concurrent: a plain one re-takes the lock the build avoids, on the retry path.
    for (const s of ran.filter((t) => t.includes("drop index"))) {
      expect(s, "a plain DROP on the retry path").toContain("concurrently");
    }
    // The acquisition is BOUNDED and the bound is lifted before any DDL — a concurrent build must
    // not be abortable by an acquisition timeout. Existence checked first: findIndex answers -1
    // for a missing statement and -1 compares smaller than everything.
    expect(at("set lock_timeout = 0")).toBeGreaterThan(-1);
    expect(at("pg_advisory_lock")).toBeGreaterThan(-1);
    expect(at("pg_advisory_lock")).toBeLessThan(at("indisvalid"));
    expect(at("set lock_timeout = 0")).toBeLessThan(at("create index concurrently"));
    expect(at("pg_advisory_unlock")).toBeGreaterThan(at("create index concurrently"));
  });

  it("a like-named index in ANOTHER schema neither satisfies nor is touched by the build", async () => {
    // An unqualified catalog lookup would read a stranger's index as ours and skip the build.
    const name = "audit_log_account_action_idx";
    await client.unsafe(`create schema if not exists shadow`);
    try {
      await client.unsafe(`create table if not exists shadow.audit_log (account_id uuid, action text)`);
      await client.unsafe(`create index "${name}" on shadow.audit_log (account_id, action)`);
      await client.unsafe(`drop index if exists public."${name}"`);
      await ensureHotPathIndexes(db);
      expect(await validOf(name), "the shadow index was mistaken for ours").toBe(true);
    } finally {
      await client.unsafe(`drop schema if exists shadow cascade`);
    }
  }, 180_000);
});
