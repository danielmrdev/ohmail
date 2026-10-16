import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import {
  BLOAT_COMPACT_MIN_BYTES,
  BLOAT_COMPACT_RATIO,
  reclaimBodyBloat,
} from "../../src/db.js";

/**
 * THE BLOAT COMPACTION, watched actually reclaiming space (owner's install, 2026-08-21).
 *
 * A real desktop mirror held its body content in a `message_bodies` table occupying
 * many times that — the residue of a since-fixed defect that re-upserted every body per poll, in a
 * database no autovacuum daemon ever visits (PGlite is a single-user backend). Plain `VACUUM`
 * frees tuples for reuse but never returns the files' high-water mark, so the install stayed at
 * 21 GB for ever and one measured launch spent 80.8 s inside `new PGlite()`.
 *
 * These tests drive {@link reclaimBodyBloat} against a real PGlite with real dead tuples: the
 * gate must not fire on a healthy table, must fire on a mostly-dead one, and the rewrite must
 * keep every live row byte-identical. The bloat is manufactured the same way the pathology was —
 * repeated updates of TOASTed rows — so the space being reclaimed is the same kind of space.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function bloatableStore(): Promise<{ client: PGlite; dir: string }> {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-compact-"));
  dirs.push(dir);
  const client = new PGlite(join(dir, "pgdata"));
  await client.waitReady;
  // The real table's shape where it matters: a TEXT column big enough to TOAST.
  await client.exec(`CREATE TABLE message_bodies (id int PRIMARY KEY, text text NOT NULL DEFAULT '', html text)`);
  return { client, dir };
}

const tableBytes = async (client: PGlite): Promise<number> => {
  const r = await client.query<{ b: string }>(
    `SELECT pg_total_relation_size('message_bodies')::text AS b`,
  );
  return Number(r.rows[0]!.b);
};

describe("reclaimBodyBloat", () => {
  it("a healthy store is left alone — the check is a size read, never a rewrite", async () => {
    const { client } = await bloatableStore();
    await client.exec(`INSERT INTO message_bodies SELECT g, repeat('x', 1000), null FROM generate_series(1, 50) g`);
    const before = await tableBytes(client);
    const out = await reclaimBodyBloat(client);
    expect(out.ran, "a small, live table was rewritten").toBe(false);
    expect(await tableBytes(client)).toBe(before);
    await client.close();
  });

  it("under the absolute floor nothing runs, however dead the table is", async () => {
    const { client } = await bloatableStore();
    await client.exec(`INSERT INTO message_bodies SELECT g, repeat('x', 100), null FROM generate_series(1, 20) g`);
    // Mostly dead — but megabytes, not gigabytes: the rewrite would save nothing anyone feels.
    for (let i = 0; i < 20; i++) await client.exec(`UPDATE message_bodies SET text = text`);
    const out = await reclaimBodyBloat(client);
    expect(out.ran).toBe(false);
    expect(out.beforeBytes).toBeLessThan(BLOAT_COMPACT_MIN_BYTES);
    await client.close();
  });

  it("a mostly-dead table is rewritten, shrinks, and keeps every live row verbatim", async () => {
    /**
     * Real dead space, made the way a reported store's was: TOASTed rows re-written over and over. The
     * content is INCOMPRESSIBLE (md5 chains) because pglz otherwise folds repeated characters to
     * nothing and no amount of churn crosses any floor — the same reason the production
     * pathology was base64-adjacent html, not spaces. The shipped 1 GiB floor would cost
     * minutes of setup to cross honestly, so the decision arithmetic runs through the injected
     * gate seam at a few megabytes, and the shipped constants are pinned by the assertions
     * below rather than exercised by brute force.
     */
    const { client } = await bloatableStore();
    await client.exec(
      `INSERT INTO message_bodies
       SELECT g, (SELECT string_agg(md5(g::text || s::text), '') FROM generate_series(1, 500) s), null
       FROM generate_series(1, 60) g`,
    );
    // ~1 MB live (60 × 16 KB, incompressible). Now kill it: every UPDATE re-TOASTs every row
    // with fresh bytes, so each pass leaves a whole dead copy of the table behind.
    for (let i = 0; i < 10; i++) {
      await client.exec(`UPDATE message_bodies SET text = md5(text) || substr(text, 33)`);
    }
    const before = await tableBytes(client);

    const out = await reclaimBodyBloat(client, undefined, undefined, { minBytes: 4 * 1024 * 1024 });
    expect(before, "the manufactured bloat never crossed the injected floor").toBeGreaterThan(4 * 1024 * 1024);
    expect(out.ran, "a mostly-dead table above the floor was not rewritten").toBe(true);
    const after = await tableBytes(client);
    expect(after, "the rewrite reclaimed nothing").toBeLessThan(before / BLOAT_COMPACT_RATIO);

    // Every live row survived at full length — the rewrite moved bytes, never content.
    const rows = await client.query<{ n: string; t: string }>(
      `SELECT count(*)::text AS n, min(length(text))::text AS t FROM message_bodies`,
    );
    expect(rows.rows[0]).toEqual({ n: "60", t: "16000" });
    await client.close();
  }, 120_000);

  /**
   * ── A SAMPLE THAT HITS NO ROWS IS NOT A MEASUREMENT OF ZERO ─────────────────────────────
   *
   * The live estimate is `reltuples × (sampled avg octet_length + header)` and the sample is
   * `TABLESAMPLE SYSTEM (1)`. A HEALTHY table can be all TOAST and almost no heap — a few large
   * bodies put megabytes in the TOAST relation (which `pg_total_relation_size` counts) behind a
   * heap of a handful of pages — and a small page sample of a handful of pages routinely returns
   * NOTHING. `avg` is then null, and reading that as 0 makes the estimate `128 × reltuples`,
   * which is small enough that any table past the floor looks like 13× dead space. The rewrite
   * then runs at boot on a table with no dead space in it, and — because the live content is
   * still past the floor — it can run again on the next launch, and the next.
   *
   * The docblock's "upper bound" claim is a claim about a statistic, so the code has to say what
   * it does when the statistic is absent: it declines. An unmeasurable table is not rewritten.
   */
  it("a healthy TOAST-heavy table whose 1% sample hits nothing is NOT rewritten", async () => {
    const { client } = await bloatableStore();
    // Megabytes of incompressible live content in large rows: all of it TOASTed, so the heap is a few
    // pages and the sample below is expected to come back empty. No churn at all — this table is
    // as healthy as a table gets.
    await client.exec(
      `INSERT INTO message_bodies
       SELECT g, (SELECT string_agg(md5(g::text || s::text), '') FROM generate_series(1, 500) s), null
       FROM generate_series(1, 60) g`,
    );
    const before = await tableBytes(client);
    // The floor is injected BELOW the live content, which is the whole point: the floor is not
    // what protects this table, the estimate is.
    const out = await reclaimBodyBloat(client, undefined, undefined, { minBytes: 512 * 1024 });
    expect(before, "the fixture never crossed the injected floor").toBeGreaterThan(512 * 1024);
    expect(out.ran, "a healthy TOAST-heavy table was rewritten on an empty sample").toBe(false);
    expect(await tableBytes(client), "the table was rewritten anyway").toBe(before);
    await client.close();
  }, 120_000);

  it("the shipped gate is the measured pathology's shape, not a test convenience", () => {
    // A reported install sat at 13× bloat and 21 GB; ordinary churn stays under 2× — the
    // constants live between the two, far from both. Pinned so the seam above cannot quietly
    // become the shipped behaviour.
    expect(BLOAT_COMPACT_RATIO).toBe(4);
    expect(BLOAT_COMPACT_MIN_BYTES).toBe(1024 * 1024 * 1024);
  });
});
