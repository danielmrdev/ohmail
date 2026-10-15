import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { pgDialect } from "@trafficflow/db/dialect";
import { afterSettings } from "../src/settings-first.js";

/**
 * The settings a search transaction writes without awaiting reach the store BEFORE its reads, on
 * both read paths the search uses (the builder and the dialect's exec) — here on the desktop's
 * store, PGlite; the hosted client's wire order is `search-pooled-handle.pg.test.ts`. A failing
 * setting fails the answer.
 */
describe("afterSettings", () => {
  const setup = sql`select set_config('ohmail.settings_first', 'on', true) as s0`;
  const read = sql<string>`current_setting('ohmail.settings_first', true)`;

  it("the reads see the transaction's settings, by the builder, by exec and by a bare execute", async () => {
    const db = await makeTestDb();
    const d = pgDialect();
    const seen = await db.transaction((t) => afterSettings(t, d, setup, async () => {
      // The bare execute first: the shortest path a read takes to the store.
      const raw = (await t.execute(sql`select ${read} as v`)) as unknown as { rows: Array<{ v: string | null }> };
      const [b] = await t.select({ v: read }).from(sql`(values (1)) as x(n)`);
      const [e] = await d.exec(t, sql`select ${read} as v`);
      return [raw.rows[0]?.v ?? null, b?.v ?? null, e?.[0] ?? null];
    }));
    expect(seen).toEqual(["on", "on", "on"]);
    // Transaction-local: gone once the transaction is.
    const [after] = await d.exec(db, sql`select ${read} as v`);
    expect(after?.[0] ?? "").toBe("");
  });

  it("a setting that fails fails the answer", async () => {
    const db = await makeTestDb();
    const d = pgDialect();
    let verdict = "answered";
    try {
      await db.transaction((t) => afterSettings(t, d, sql`select 1 / 0 as s0`, async () => d.exec(t, sql`select 1`)));
    } catch {
      verdict = "refused";
    }
    expect(verdict).toBe("refused");
  });
});
