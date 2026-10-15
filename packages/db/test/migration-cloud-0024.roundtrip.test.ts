import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";

/**
 * Proves CLOUD migration 0024 persists its one artifact — the PARTIAL index the
 * reuse-revocation readers scan by — with the exact predicate both readers name.
 *
 * The index is the migration's WHOLE content, so this file is what stands between "the journal
 * says it ran" and "the database has it" (the 0013 roundtrip's argument): a database that took
 * `auth_events` by hand without it would answer every query correctly and walk the unbounded
 * login ledger on every alert pass — the silent-slow failure the index-marker class exists for,
 * asserted here at migration time rather than discovered on `/health`.
 *
 * Replays into PGlite via `makeTestDb` (both journals).
 */
describe("cloud migration 0024 round-trip (the reuse-revocation partial index)", () => {
  it("the partial index exists, on (account_id, at), predicated on the one event both readers name", async () => {
    const db = await makeTestDb();
    const res = await db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
       where schemaname = 'public' and indexname = 'auth_events_reuse_account_at_idx'`);
    const rows = Array.isArray(res) ? res : (res as unknown as { rows: { indexdef: string }[] }).rows;
    expect(rows, "the migration's whole content is this index — its absence is the migration not having run").toHaveLength(1);
    const def = (rows as { indexdef: string }[])[0]!.indexdef;
    // The definition IS the invariant (the 0013 pin's rule): the two columns the account view
    // orders by, and the partial predicate that keeps the login ledger out of the index.
    expect(def).toContain("account_id");
    expect(def).toContain("at");
    expect(def).toContain("refresh_reuse_revoked");
    expect(def).not.toContain("UNIQUE");
  });
});
