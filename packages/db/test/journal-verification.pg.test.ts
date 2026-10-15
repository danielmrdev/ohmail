import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { brandDialect } from "../src/dialect/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  adoptReissuedOriginals, ensureOneRowPerWhen, migrationSqlHash, readJournalOf,
  type JournalEntry, type JournalSpec,
} from "../src/baseline.js";
import {
  appliedRowsOf, digestMismatches, journalProblems, journalStatuses, readJournals,
  type JournalStatus,
} from "../src/setup-prod.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * A JOURNAL ENTRY MEANS THE SQL IT NAMES RAN — so verification compares CONTENT, never a clock.
 *
 * `setup-prod.ts` used to take a matching `created_at` as proof that a migration had been
 * applied. Both failures it exists to catch are silent under that test: two lanes colliding on a
 * `when` make drizzle record the later entry as applied WITHOUT running it, and an edited
 * already-applied migration leaves the database without the change while the stamp never moves.
 * Measured on a lane database before the fix — a row rewritten to name different SQL, the stamp
 * untouched, and the verifier returned the same zero problems as the honest reading.
 *
 * drizzle has always written `sha256(<the .sql file>)` into the same row. Nothing had to be
 * invented and no column had to be added; the verifier simply never selected it.
 *
 * The arms below run against a schema of this worktree's OWN lane database, shaped exactly like
 * drizzle's table, rather than by rewriting a live journal's bookkeeping — a co-tenant in the
 * same run reads those tables.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MAIL_DIR = join(HERE, "..", "..", "db-mail", "drizzle");
const CLOUD_DIR = join(HERE, "..", "drizzle-cloud");

/** A schema of our own, so nothing here touches `drizzle_mail` / `drizzle_cloud`. */
const SCHEMA = `drizzle_jv_${randomBytes(4).toString("hex")}`;

const PG_UP = await realPgAvailable(PG_TEST_URL);

/** The first two mail entries, which is enough to state every case and keeps the fixture small. */
const ENTRIES: JournalEntry[] = readJournalOf({
  name: "mail", dir: MAIL_DIR, migrationsSchema: "drizzle_mail",
}).slice(0, 2);

const SPEC: JournalSpec = { name: "mail", dir: MAIL_DIR, migrationsSchema: SCHEMA };
/** Same table, addressed as the CLOUD journal — the half that has no reissue. */
const CLOUD_SPEC: JournalSpec = { name: "cloud", dir: CLOUD_DIR, migrationsSchema: SCHEMA };

/**
 * An honest row is seeded with DRIZZLE'S OWN hash, read from the migrator's own reader — never
 * with `migrationSqlHash`. A positive control fed by the thing under test agrees with itself:
 * the first version of this file seeded both sides from `migrationSqlHash` and stayed green
 * while that function was mutated to hash something else entirely.
 */
const DRIZZLE_HASH = new Map<number, string>(
  readMigrationFiles({ migrationsFolder: MAIL_DIR }).map((m) => [Number(m.folderMillis), m.hash]),
);

describe("the hash this tree computes IS the hash drizzle's migrator records", () => {
  /**
   * REPRODUCED, NOT INVENTED. `readMigrationFiles` is the migrator's own reader — the function
   * whose `hash` field `PgDialect.migrate` inserts — so this compares our computation against
   * the thing production rows were actually written by, for every entry of both journals. A
   * hasher that agreed with itself and not with drizzle would refuse every honest deployment.
   */
  it.each([["mail"], ["cloud"]] as const)("%s: every shipped entry, against the migrator's own reader", (name) => {
    const { spec, entries } = readJournals().find((j) => j.spec.name === name)!;
    const theirs = new Map(
      readMigrationFiles({ migrationsFolder: spec.dir }).map((m) => [Number(m.folderMillis), m.hash]),
    );
    expect(theirs.size, "the migrator read no migrations — the folder moved").toBe(entries.length);
    const disagree = entries
      .filter((e) => theirs.get(e.when) !== migrationSqlHash(spec, e.tag))
      .map((e) => e.tag);
    expect(disagree, "migrationSqlHash has drifted from drizzle's readMigrationFiles").toEqual([]);
  });
});

describe.skipIf(!PG_UP)("journal verification compares content", () => {
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<Record<string, never>>;
  const TABLE = `"${SCHEMA}"."__drizzle_migrations"`;

  /** Drizzle's own table shape, copied from `PgDialect.migrate` — hash first, stamp second. */
  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    db = brandDialect(drizzle(client), "pg");
    await client.unsafe(`create schema if not exists "${SCHEMA}"`);
    await client.unsafe(
      `create table if not exists ${TABLE} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
  }, 60_000);

  afterAll(async () => {
    await client?.unsafe(`drop schema if exists "${SCHEMA}" cascade`).catch(() => {});
    await client?.end({ timeout: 5 }).catch(() => {});
  }, 60_000);

  beforeEach(async () => {
    await client.unsafe(`drop index if exists "${SCHEMA}"."__drizzle_migrations_created_at_uq_${SCHEMA}"`);
    await client.unsafe(`truncate ${TABLE}`);
  });

  const record = async (entry: JournalEntry, hash: string) => {
    await client.unsafe(
      `insert into ${TABLE} ("hash", "created_at") values ('${hash}', ${entry.when})`,
    );
  };
  const honestly = async (entry: JournalEntry) => record(entry, DRIZZLE_HASH.get(entry.when)!);
  const statuses = async (): Promise<JournalStatus[]> =>
    journalStatuses(db, new Map(), [{ spec: SPEC, entries: ENTRIES }]);

  it("an honest deployment verifies — every row describes the SQL this tree ships", async () => {
    for (const e of ENTRIES) await honestly(e);
    const [status] = await statuses();
    expect(status!.applied).toBe(ENTRIES.length);
    expect(status!.missing).toEqual([]);
    expect(status!.mismatched).toEqual([]);
    expect(journalProblems([status!])).toEqual([]);
  });

  it("a stamp that matches while the SQL differs is REFUSED, naming both readings", async () => {
    const lie = "0".repeat(63) + "1";
    await honestly(ENTRIES[0]!);
    await record(ENTRIES[1]!, lie);

    const [status] = await statuses();
    // Not "incomplete": the row IS there, at the right `when`. That is the whole point.
    expect(status!.missing).toEqual([]);
    expect(status!.applied).toBe(ENTRIES.length);
    expect(status!.mismatched.map((m) => m.tag)).toEqual([ENTRIES[1]!.tag]);

    const problems = journalProblems([status!]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("MISDESCRIBED");
    expect(problems[0]).toContain(ENTRIES[1]!.tag);
    expect(problems[0], "the shipped SQL's sha256 is not named").toContain(
      migrationSqlHash(SPEC, ENTRIES[1]!.tag),
    );
    expect(problems[0], "what the table records is not named").toContain(lie);
  });

  it("an ABSENT row is incomplete, not misdescribed — the two problems stay apart", async () => {
    await honestly(ENTRIES[0]!);
    const [status] = await statuses();
    expect(status!.missing).toEqual([ENTRIES[1]!.tag]);
    expect(status!.mismatched).toEqual([]);
    const problems = journalProblems([status!]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INCOMPLETE");
  });

  it("two rows at one `when` are reported as the collision they are", async () => {
    // The state a database predating the unique index can be in: one `when`, two rows. The old
    // reader collapsed them into a Set and reported the journal complete.
    await honestly(ENTRIES[0]!);
    await honestly(ENTRIES[0]!);
    await honestly(ENTRIES[1]!);
    const recorded = await appliedRowsOf(db, SPEC);
    expect(recorded.get(ENTRIES[0]!.when)).toHaveLength(2);
    const mismatches = digestMismatches(SPEC, ENTRIES, recorded);
    expect(mismatches.map((m) => m.tag)).toEqual([ENTRIES[0]!.tag]);
    expect(mismatches[0]!.rowsAtWhen).toBe(2);
    expect(journalProblems(await statuses())[0]).toContain("2 rows at this 'when'");
  });

  it("the WRITER refuses a second row at one `when`", async () => {
    await ensureOneRowPerWhen(db, SPEC);
    await honestly(ENTRIES[0]!);
    // A one-word verdict: `.rejects` on a live postgres handle takes the worker with it.
    const verdict = await client
      .unsafe(`insert into ${TABLE} ("hash", "created_at") values ('x', ${ENTRIES[0]!.when})`)
      .then(() => "admitted")
      .catch(() => "refused");
    expect(verdict).toBe("refused");
  });

  it("the collision constraint reaches the CLOUD journal too, which has no reissue", async () => {
    // `adoptReissuedOriginals` used to create the index AFTER returning early for a journal with
    // no reissue — which is `cloud`, on every virgin deployment. It runs after the migrator, so
    // that was the only place the constraint could arrive.
    const took = await adoptReissuedOriginals(db, CLOUD_SPEC);
    expect(took, "the cloud journal has no reissue to adopt").toEqual([]);
    const idx = await client.unsafe(
      `select indexname from pg_indexes where schemaname = '${SCHEMA}'
         and indexname = '__drizzle_migrations_created_at_uq_${SCHEMA}'`,
    );
    expect(idx.length, "the cloud journal's table was left with no constraint on `when`").toBe(1);
  });
});
