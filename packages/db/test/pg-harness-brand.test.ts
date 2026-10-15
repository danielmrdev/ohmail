import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY POSTGRES HARNESS BRANDS THE HANDLE IT OPENS — a census, because the alternative is one
 * red per lane for a year.
 *
 * The dialect seam refuses a handle no factory has branded, and that refusal is the right one:
 * answering "pg" for an unbranded handle would make every unbranded path silently Postgres-only
 * on a device that has no Postgres. The consequence is that a test file which opens its own
 * connection — `db = drizzle(client, { schema })` — is a factory, and owes the same brand the
 * production factories give (`makeDb`, `makeOwnedDb`, `makePooledDb` all call it).
 *
 * ── WHY THIS IS A CENSUS AND NOT A NOTE ───────────────────────────────────────────────────
 *
 * There were 146 of them. Each one is green until some port gives its path a statement the seam
 * has to compose, and then it fails with a message about a dialect brand in a test about
 * screening or sending or eviction — a red whose text has nothing to do with what the file is
 * for. That happened twice on the way here, once in a file whose two cases never reached their
 * assertions at all, and both times the first reading was "did I break routing".
 *
 * Branding them was a one-line edit per file. Keeping them branded is this.
 *
 * ── WHAT IT LOOKS AT ──────────────────────────────────────────────────────────────────────
 *
 * Only `*.pg.test.ts`: those are the files that open a real connection. A `drizzle(` call that
 * is not immediately inside `brandDialect(` is a finding, and the file and line are named so the
 * fix is the same one-line edit every time.
 *
 * ── TO WATCH THIS FAIL ────────────────────────────────────────────────────────────────────
 *
 * Remove `brandDialect(` from any one of them and re-run; it names that file and that line. The
 * negative half matters too and is asserted below: the census must be looking at a real and
 * substantial set, or a pattern that stopped matching would report a clean sweep of nothing.
 */
const ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

/** Every `*.pg.test.ts` under the workspace's test directories. */
function pgTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === "dist") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".pg.test.ts")) out.push(p.slice(ROOT.length + 1));
    }
  };
  for (const top of ["packages", "apps"]) walk(join(ROOT, top));
  return out.sort();
}

/**
 * A `drizzle(` that is NOT the argument of `brandDialect(`.
 *
 * The import line is excluded by requiring a `(` — `import { drizzle } from …` has none — and a
 * call already inside `brandDialect(` is excluded by the lookbehind. Both are checked by the
 * cases below rather than assumed.
 */
const UNBRANDED = /(?<!brandDialect\()\bdrizzle\s*\(/g;

describe("every Postgres harness brands the handle it opens", () => {
  const files = pgTestFiles();

  it("is looking at a real set of harnesses, or a clean sweep means nothing", () => {
    expect(files.length, "no `*.pg.test.ts` files were found at all — this census has no subject")
      .toBeGreaterThan(100);
    expect(files.some((f) => f.startsWith("apps/worker/test/"))).toBe(true);
    expect(files.some((f) => f.startsWith("packages/services/test/"))).toBe(true);
  });

  it("finds no handle opened without one", () => {
    const unbranded: string[] = [];
    for (const file of files) {
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
        for (const _m of line.matchAll(new RegExp(UNBRANDED.source, "g"))) {
          unbranded.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(unbranded,
      "a Postgres harness opens a handle the dialect seam will refuse. Wrap it: " +
      "`brandDialect(drizzle(client, { schema }), \"pg\")` — the same thing every production " +
      "factory does. Left unbranded it is green until a port gives its path a statement the " +
      "seam composes, and then it fails with a message about dialects in a test about " +
      "something else entirely.").toEqual([]);
  });

  it("recognises both halves of what it is looking for, on text rather than on trust", () => {
    const hits = (s: string): number => [...s.matchAll(new RegExp(UNBRANDED.source, "g"))].length;
    // The shape it must find…
    expect(hits('const db = drizzle(client, { schema });')).toBe(1);
    expect(hits('db = drizzle(sql, { schema }) as unknown as Tx;')).toBe(1);
    // …and the two it must not.
    expect(hits('const db = brandDialect(drizzle(client, { schema }), "pg");')).toBe(0);
    expect(hits('import { drizzle } from "drizzle-orm/postgres-js";')).toBe(0);
  });
});
