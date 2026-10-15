import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAIL_JOURNAL } from "@trafficflow/db/journal";
import { openLocalDb } from "../src/db.js";
import { freshDataDir, templateKey, templatePathFor } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

/**
 * THE FIXTURE THAT MAKES THE SIDECAR SUITE AFFORDABLE, AND WHAT WOULD MAKE IT LIE.
 *
 * `freshDataDir` hands out copies of one initialised, migrated PGDATA instead of paying `initdb`
 * per test — 10 072 ms down to 82 ms + 19 ms, measured at main. Two ways that could be silently
 * wrong, and both are checked here: a copy that is NOT migrated (every later assertion then fails
 * naming the product), and a key that does not move with the journal (a stale schema surviving a
 * migration, which is the drift `journalDrift` exists to refuse, arriving through a cache).
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** How many mail migrations this tree declares — read from the journal, never typed here. */
function declared(): number {
  const j = JSON.parse(readFileSync(join(MAIL_JOURNAL.dir, "meta", "_journal.json"), "utf8")) as
    { entries: unknown[] };
  return j.entries.length;
}

describe("the sidecar's PGDATA template", () => {
  it("hands out a directory whose store is already there", async () => {
    const dir = await freshDataDir("ohmail-datadir-probe-");
    dirs.push(dir);
    expect(existsSync(join(dir, "pgdata", "PG_VERSION")),
      "the copy has no PG_VERSION — the template did not land and every later test pays initdb").toBe(true);
    // Nothing but pgdata: the install identity and the cursor files must still be a first launch.
    expect(readdirSync(dir).sort()).toEqual(["pgdata"]);
  }, PGLITE_STANDUP_BUDGET_MS);

  it("hands out a MIGRATED store — the migrator finds nothing left to do", async () => {
    const dir = await freshDataDir("ohmail-datadir-migrated-");
    dirs.push(dir);
    const opened = await openLocalDb(dir);
    try {
      const rows = await opened.db.execute(
        `select count(*)::int as n from "${MAIL_JOURNAL.migrationsSchema}"."__drizzle_migrations"`,
      ) as unknown as { rows?: Array<{ n: number }> } & Array<{ n: number }>;
      const applied = Number((rows.rows ?? rows)[0]?.n ?? 0);
      expect(applied, "the template's journal is empty — the copy carries no schema")
        .toBeGreaterThan(50);
      expect(applied).toBe(declared());
    } finally {
      await opened.close();
    }
  }, PGLITE_STANDUP_BUDGET_MS);

  /**
   * Against a COPY of the journal, so the arm is about the migration's BYTES rather than about a
   * salt the test itself supplies — and so nothing tracked is edited to measure it.
   */
  it("keys the template on the journal's bytes: an edited migration gets its own template", () => {
    const copy = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-journal-copy-"));
    dirs.push(copy);
    cpSync(MAIL_JOURNAL.dir, copy, { recursive: true });
    const before = templateKey(copy);
    expect(before, "the copy hashes to nothing — the key read no journal at all").toMatch(/^[0-9a-f]{16}$/);
    expect(before, "a copy of the journal keys differently from the journal — the key is reading "
      + "something other than the journal's own bytes").toEqual(templateKey());

    const newest = readdirSync(copy).filter((f) => f.endsWith(".sql")).sort().at(-1)!;
    appendFileSync(join(copy, newest), "\n-- one more statement's worth of bytes\n");
    expect(templateKey(copy), "an edited migration keys to the same template — the old schema "
      + "would be served for ever").not.toEqual(before);
    expect(templatePathFor(templateKey(copy))).not.toEqual(templatePathFor(before));

    // And the journal INDEX counts too: a re-ordered or renamed entry is a different schema.
    const j = join(copy, "meta", "_journal.json");
    const parsed = JSON.parse(readFileSync(j, "utf8")) as { entries: unknown[] };
    parsed.entries = parsed.entries.slice(0, -1);
    writeFileSync(j, JSON.stringify(parsed));
    expect(templateKey(copy)).not.toEqual(before);
  });

  it("can be turned off, and then the directory is empty", async () => {
    process.env.OHMAIL_PGDATA_TEMPLATE = "0";
    try {
      const dir = await freshDataDir("ohmail-datadir-off-");
      dirs.push(dir);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      delete process.env.OHMAIL_PGDATA_TEMPLATE;
    }
  });
});
