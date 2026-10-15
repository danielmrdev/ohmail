import { describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable,
  throwawayDb,
} from "../src/testing.js";
import { runMigrations } from "../src/migrate.js";

/**
 * THE HELPER THAT BUILDS A TEST'S OWN DATABASE, and the property that matters most about it: a
 * setup that DOES NOT FINISH leaves nothing on the cluster. A hook that times out is abandoned
 * where it stands — the create has happened, the migrate is still in flight, and nothing after
 * the `await` will ever run — so the teardown, not the setup, has to be the thing that removes
 * the database. That is why `drop` is unconditional and idempotent rather than guarded by a flag
 * the setup sets.
 */
const PG_UP = await realPgAvailable();

/** Does the cluster still hold it? Asked from OUTSIDE the handle, on a maintenance connection. */
async function onCluster(name: string): Promise<boolean> {
  const u = new URL(PG_TEST_URL);
  u.pathname = "/postgres";
  const admin = postgres(u.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    return rows.length > 0;
  } finally {
    await admin.end({ timeout: 5 });
  }
}

describe.skipIf(!PG_UP)("a throwaway database is built and always removed", () => {
  /** THE POSITIVE CONTROL: the ordinary case is admitted, and what it builds is really there. */
  it("builds a migrated database and removes it again", async () => {
    const db = throwawayDb("tf_throwaway_ok");
    await db.create((url) => runMigrations(url));
    expect(await onCluster(db.name), "the database the handle named is not on the cluster").toBe(true);

    const client = postgres(db.url, { max: 1, onnotice: () => {} });
    try {
      const rows = await client`SELECT count(*)::int AS n FROM accounts`;
      expect((rows[0] as { n: number }).n, "the schema did not migrate").toBe(0);
    } finally {
      await client.end({ timeout: 5 });
    }

    await db.drop();
    expect(await onCluster(db.name)).toBe(false);
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  it("a REFUSED setup leaves no database behind, and the setup's own failure is what surfaces", async () => {
    const db = throwawayDb("tf_throwaway_refused");
    const boom = new Error("the migration step refused");
    // The create half succeeded — the database existed a moment ago — and the migrate half threw.
    const thrown = await db.create(() => Promise.reject(boom)).then(() => null, (e: unknown) => e);
    expect(thrown, "the helper swallowed the setup's failure").toBe(boom);
    expect(await onCluster(db.name),
      "a refused setup left its half-built database on the cluster").toBe(false);
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  it("the teardown is safe when the setup never ran — the timed-out-hook case", async () => {
    const db = throwawayDb("tf_throwaway_never");
    // vitest runs the teardown for a suite whose setup hook failed or timed out, so `drop` is
    // called on a handle that may never have created anything.
    await expect(db.drop()).resolves.toBeUndefined();
    expect(await onCluster(db.name)).toBe(false);
    // …and twice, because an abandoned setup can also finish AFTER the teardown started.
    await expect(db.drop()).resolves.toBeUndefined();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("a name that is not an identifier is refused before anything is built", () => {
    // The value is interpolated into DDL, so the refusal is the injection defence, not tidiness.
    expect(() => throwawayDb('x"; drop database "postgres')).toThrow(/not usable as a database name/);
    expect(() => throwawayDb("Mixed_Case")).toThrow(/not usable as a database name/);
  });
});
