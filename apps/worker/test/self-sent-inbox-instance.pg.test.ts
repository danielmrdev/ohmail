import { afterAll, describe } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { schema } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { describeSelfSent } from "./_self-sent-suite.js";

/**
 * The same suite on REAL Postgres — the Cloud worker's store, where the repair's repoint, the
 * witnessed folder write and the read-state adoption commit in one transaction PGlite does not
 * witness. Every read is scoped to the case's own account and mailbox; the second run is the
 * same cases in reverse order, the co-tenancy control.
 */
const AVAILABLE = await realPgAvailable();
let sql: ReturnType<typeof postgres> | undefined;
let db: Promise<Tx> | undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

const open = (): Promise<Tx> => (db ??= (async () => {
  await runMigrations(PG_TEST_URL);
  sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
  return brandDialect(drizzle(sql, { schema }), "pg") as unknown as Tx;
})());

if (AVAILABLE) {
  describeSelfSent("real Postgres", open);
  describeSelfSent("real Postgres", open, "reverse");
} else {
  describe.skip("real Postgres — a letter to yourself reaches the Ohbox (no lane database)", () => {});
}
