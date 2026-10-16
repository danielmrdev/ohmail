import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CONSTRAINTS A MIGRATION DROPPED AND RE-ADDED UNDER A DIFFERENT NAME — the amendment shape a
 * same-name check cannot express. Mail 0118 replaces 28 single-column foreign keys with composite
 * `(child_id, account_id)` ones, each under a NEW name, so neither the frozen catalog's line nor
 * its `CONSTRAINT <table> <name>` identity survives and the two schema censuses read a deliberate
 * replacement as a lost object. Derived from the migration SQL rather than listed, on the rule
 * those files already follow for what a migration BUILDS: 28 literals are a census only while
 * somebody re-derives them.
 */

/** `CONSTRAINT <table> <name>` — the identity both censuses key on. */
const identityOf = (table: string, name: string): string => `CONSTRAINT ${table} ${name}`;

interface JournalEntry { when: number; tag: string }

/**
 * Old identity → the identity that replaced it, over every migration authored after `minWhen`.
 *
 * FAIL-CLOSED: a drop the SQL does not pair with an add on the SAME table yields no entry, so the
 * census still refuses it. A drop re-added under the SAME name yields no entry either — that is
 * the in-place amendment the callers' own same-identity rule already forgives, and pairing it
 * here would hide a rename behind it.
 */
export function replacedConstraints(
  dirs: readonly string[], minWhen: number,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const dir of dirs) {
    const journal = JSON.parse(
      readFileSync(join(dir, "meta", "_journal.json"), "utf8"),
    ) as { entries: JournalEntry[] };
    for (const entry of journal.entries.filter((e) => e.when > minWhen)) {
      // SPLIT ON THE BREAKPOINT FIRST and strip comments per statement: `--> statement-breakpoint`
      // is itself a `--` line, so stripping first fuses the whole file into one statement and a
      // lazy match then pairs a DROP on one table with an ADD on another.
      const stmts = readFileSync(join(dir, `${entry.tag}.sql`), "utf8")
        .split("--> statement-breakpoint")
        .map((s) => s.replace(/^\s*--[^\n]*$/gm, ""));
      const adds: Array<{ table: string; name: string; used: boolean }> = [];
      for (const s of stmts) {
        const m = /ALTER TABLE "([a-z_]+)"\s+ADD CONSTRAINT "([a-z_]+)"/i.exec(s);
        if (m) adds.push({ table: m[1]!, name: m[2]!, used: false });
      }
      for (const s of stmts) {
        const d = /ALTER TABLE "([a-z_]+)"\s+DROP CONSTRAINT (?:IF EXISTS )?"([a-z_]+)"/i.exec(s);
        if (!d) continue;
        const table = d[1]!, old = d[2]!;
        if (adds.some((a) => a.table === table && a.name === old)) continue;
        const cand = adds.find((a) => !a.used && a.table === table);
        if (!cand) continue;
        cand.used = true;
        out.set(identityOf(table, old), identityOf(cand.table, cand.name));
      }
    }
  }
  return out;
}

/**
 * FOREIGN KEY names MORE THAN ONE journal creates — the reason a dropped key can still be on the
 * server. `refresh_tokens`' two keys are authored in both mail 0060 and the cloud auth ceremony,
 * so whichever journal the migrator runs second re-adds what mail 0118 dropped. Derived, because
 * a hand-written skip list would grow silently every time the two journals overlap again.
 */
export function crossJournalConstraints(dirs: readonly string[]): ReadonlySet<string> {
  const byName = new Map<string, Set<string>>();
  for (const dir of dirs) {
    const journal = JSON.parse(
      readFileSync(join(dir, "meta", "_journal.json"), "utf8"),
    ) as { entries: JournalEntry[] };
    for (const entry of journal.entries) {
      const text = readFileSync(join(dir, `${entry.tag}.sql`), "utf8");
      for (const m of text.matchAll(/CONSTRAINT "([a-z_]+)"\s+FOREIGN KEY/gi)) {
        (byName.get(m[1]!) ?? byName.set(m[1]!, new Set()).get(m[1]!)!).add(dir);
      }
    }
  }
  return new Set([...byName].filter(([, dirs]) => dirs.size > 1).map(([name]) => name));
}
