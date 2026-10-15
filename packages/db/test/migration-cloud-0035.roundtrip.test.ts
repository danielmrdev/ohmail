import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";

/**
 * Proves CLOUD migration 0035 persists both of its artifacts — the two PARTIAL indexes
 * `consumeChallenge` reads open passkey ceremonies by, one per selector arm.
 *
 * The indexes ARE the migration, so this file is what stands between "the journal says it ran"
 * and "the database has them": a database without them answers every ceremony correctly and scans
 * every open challenge on the deployment to do it — the silent-slow shape the index-marker class
 * exists for. Whether the PLANNER takes them is a different question and a different store; it is
 * asked on real Postgres in `hot-path-reads.pg.test.ts`.
 */
describe("cloud migration 0035 round-trip (the two open-ceremony partial indexes)", () => {
  it("both indexes exist, on their own selector, partial on the predicate every read carries", async () => {
    const db = await makeTestDb();
    const res = await db.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes
       where schemaname = 'public' and tablename = 'webauthn_challenges'`);
    type Row = { indexname: string; indexdef: string };
    const rows: Row[] = Array.isArray(res)
      ? (res as Row[])
      : (res as unknown as { rows: Row[] }).rows;
    const def = (name: string): string => {
      const hit = rows.find((r) => r.indexname === name);
      expect(hit, `${name} is absent — the migration has not run`).toBeDefined();
      return hit!.indexdef;
    };

    // Its own selector leads, because exactly one of the two is non-null on any row and a single
    // leading column therefore cannot serve both arms.
    const login = def("webauthn_challenges_open_login_idx");
    expect(login).toContain("login_token_id");
    expect(login).not.toContain("user_id");
    const user = def("webauthn_challenges_open_user_idx");
    expect(user).toContain("user_id");
    expect(user).not.toContain("login_token_id");

    for (const [name, d] of [["open_login", login], ["open_user", user]] as const) {
      // `type` and `created_at` are in the key: the first narrows the arm, the second is what lets
      // the `LIMIT 1` stop at the first tuple instead of sorting however many ceremonies one
      // caller chose to open.
      expect(d, `${name} lost its type column`).toContain("type");
      expect(d, `${name} lost created_at, so the read sorts again`).toContain("created_at");
      // PARTIAL on the one predicate all three call arms carry.
      expect(d, `${name} is not partial — it holds consumed ceremonies too`).toContain("consumed_at IS NULL");
      // Not unique: a caller may hold several open ceremonies at once, and two of them colliding
      // must degrade to "the newest wins", never to a refused sign-in.
      expect(d, `${name} is UNIQUE — a second open ceremony would be refused`).not.toContain("UNIQUE");
    }

    // 0034's prune key is still here: 0035 adds to this table, it does not replace.
    expect(def("webauthn_challenges_expires_idx")).toContain("expires_at");
  });
});
