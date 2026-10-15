import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { runMigrations, CLOUD_MIGRATIONS_DIR } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * Cloud 0032 retires the metering tables and then drops the ledger's four trigger functions, but
 * only when no retired table was left standing. Nothing read `pg_proc` afterwards, so a 0032 that
 * kept the functions, or dropped them under a surviving table, passed every suite. The block is
 * replayed inside a transaction that is always rolled back, so the lane database is untouched.
 */
const PG_UP = await realPgAvailable();
const FUNCTIONS = [
  "credit_assert_coupled", "credit_ledger_block_mutation",
  "credit_ledger_check_refund_origin", "credit_ledger_check_trial_guard",
] as const;
const RETIRE_SQL = readFileSync(join(CLOUD_MIGRATIONS_DIR, "0032_retire_billing_tables.sql"), "utf8");

class Rollback extends Error {}

describe.skipIf(!PG_UP)("cloud 0032 and the four ledger functions, on real Postgres", () => {
  const notices: string[] = [];
  const client = postgres(PG_TEST_URL, { max: 1, onnotice: (n) => { notices.push(String(n.message)); } });
  beforeAll(async () => { await runMigrations(PG_TEST_URL); }, 180_000);
  afterAll(async () => { await client.end({ timeout: 5 }); });

  const present = async (q: postgres.Sql | postgres.TransactionSql): Promise<string[]> =>
    (await q<{ proname: string }[]>`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ${q(FUNCTIONS as unknown as string[])}
       order by p.proname`).map((r) => r.proname);

  const stubs = async (tx: postgres.TransactionSql) => {
    for (const fn of FUNCTIONS) {
      await tx.unsafe(`create function public.${fn}() returns trigger language plpgsql as $$ begin return null; end $$`);
    }
  };

  /** Runs `body` in a transaction and rolls it back whatever it did; returns what it returned. */
  async function rolledBack<T>(body: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let out: T | undefined;
    await client.begin(async (tx) => { out = await body(tx); throw new Rollback(); })
      .catch((e: unknown) => { if (!(e instanceof Rollback)) throw e; });
    return out as T;
  }

  it("a migrated database carries none of the four", async () => {
    expect(await present(client)).toEqual([]);
  });

  it("0032's block drops all four when no retired table is left — the read sees them first", async () => {
    const seen = await rolledBack(async (tx) => {
      await stubs(tx);
      const before = await present(tx);
      await tx.unsafe(RETIRE_SQL);
      return { before, after: await present(tx) };
    });
    // THE POSITIVE CONTROL through the same read: four stubs are four rows, so the zero is real.
    expect(seen.before).toEqual([...FUNCTIONS].sort());
    expect(seen.after, "0032 left a ledger function behind").toEqual([]);
    expect(await present(client), "the rollback leaked a stub").toEqual([]);
  });

  it("…and keeps them while a retired table still holds rows — its triggers still need them", async () => {
    notices.length = 0;
    const seen = await rolledBack(async (tx) => {
      await stubs(tx);
      await tx.unsafe(`create table public.platform_costs (id int)`);
      await tx.unsafe(`insert into public.platform_costs values (1)`);
      await tx.unsafe(RETIRE_SQL);
      const [kept] = await tx<{ n: number }[]>`select count(*)::int as n from public.platform_costs`;
      return { after: await present(tx), rows: kept!.n };
    });
    expect(seen.after, "0032 dropped the functions under a surviving table").toEqual([...FUNCTIONS].sort());
    expect(seen.rows).toBe(1);
    expect(notices.some((m) => m.includes("platform_costs") && m.includes("LEFT IN PLACE"))).toBe(true);
  });
});
