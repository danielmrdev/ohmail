import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { wireInstant } from "../src/mailbox-service.js";

/**
 * THE WIRE FORMAT DID NOT CHANGE WHEN IT STOPPED BEING RENDERED IN SQL.
 *
 * The pull baseline was formatted by the database — `to_char(… at time zone 'utc',
 * 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` — for a reason that is still true: the ordinary cast renders at
 * the SERVER's configured date style, a space separator and a `+00` offset, which `Date.parse` is
 * not required to accept. A rejected format is a NaN baseline and a spinner that runs to its cap.
 *
 * The reason was never that SQL had to do it, and the expression was one only Postgres can render.
 * So it moved into the caller — and this is the case that says the move cost nothing, by asking the
 * DATABASE for the old answer and the helper for the new one and comparing the two byte for byte.
 * Asserting "it looks like an ISO string" would have proven nothing about the change.
 *
 * ── THE INSTANTS ARE CHOSEN, NOT ROUND ────────────────────────────────────────────────────
 *
 * A whole second hides a truncation; a value with sub-millisecond digits is where the two could
 * disagree; and a DST boundary is where a formatter that quietly consults a local zone gives itself
 * away — which the old expression guarded against by naming UTC explicitly.
 */
const INSTANTS: ReadonlyArray<readonly [string, string]> = [
  ["a whole second, where a truncation would hide", "2026-02-11T09:30:00.000Z"],
  ["milliseconds that are not zero", "2026-06-15T12:00:00.123Z"],
  // 02:30 local on the European spring-forward night, expressed in UTC. A formatter reading a
  // local zone renders this an hour out; one that names UTC does not.
  ["a DST boundary", "2026-03-29T01:30:00.456Z"],
];

describe("the pull baseline's wire format", () => {
  for (const [what, iso] of INSTANTS) {
    it(`is byte-for-byte what the database used to render — ${what}`, async () => {
      const db = await makeTestDb();
      const at = new Date(iso);
      const rows = await db.execute(sql`
        select to_char(${at.toISOString()}::timestamptz at time zone 'utc',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as rendered`);
      const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: unknown[] }).rows;
      const fromDatabase = (list[0] as { rendered: string }).rendered;

      expect(wireInstant(at)).toBe(fromDatabase);
    });
  }

  it("carries a missing instant through as missing, rather than as a formatted epoch", () => {
    // The column is nullable and the caller filters on it. `new Date(null)` is 1970, which would
    // read as a standing request made fifty-six years ago and pass every freshness test there is.
    expect(wireInstant(null)).toBeNull();
  });
});
