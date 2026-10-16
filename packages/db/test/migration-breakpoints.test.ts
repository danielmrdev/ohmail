import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY MIGRATION STATEMENT NEEDS ITS OWN `--> statement-breakpoint`, and nothing enforced it.
 *
 * ── THE FAILURE, MEASURED ───────────────────────────────────────────────────────────────────
 *
 * Both journals are registered with `"breakpoints": true`, so the migrator splits each file on
 * `--> statement-breakpoint` and sends every resulting chunk as ONE prepared statement. A chunk
 * holding two statements is refused by Postgres with:
 *
 *     cannot insert multiple commands into a prepared statement
 *
 * A hand-written migration is where this gets missed, because the marker is a comment: the file
 * reads correctly, `psql` would run it happily, and review sees nothing wrong. `0087` was written
 * with eleven statements and zero markers and looked perfectly fine.
 *
 * ── WHY IT IS WORTH A GUARD RATHER THAN A NOTE ──────────────────────────────────────────────
 *
 * The blast radius is the whole repository and the symptom points AWAY from the cause. Every
 * PGlite-backed test replays the entire journal at setup, so one malformed file turns dozens of
 * unrelated suites red at once — the first casualties observed were an attachments bounds test and
 * a billing bounty test, neither of which has anything to do with the migration that broke them. A
 * lane seeing that would reasonably conclude somebody else's slice had broken the tree.
 *
 * It would also break every desktop launch, since the engine replays the journal at every boot,
 * and it fails at RUN time — so a deploy is where a production database would find out.
 *
 * ── THE ORACLE ──────────────────────────────────────────────────────────────────────────────
 *
 * Split each file on the marker exactly as the migrator does, then count TOP-LEVEL statements in
 * each chunk. More than one in any chunk is the defect. Counting is conservative and lexical: a
 * `;` at paren depth zero that is not inside a comment, a quoted string, a quoted identifier or a
 * DOLLAR-QUOTED body. The dollar-quoting is not optional — 38 existing migrations carry `$$`
 * bodies full of semicolons, and a scanner without it would report the whole history as broken,
 * which is the shape of guard that gets deleted rather than fixed.
 */

const HERE = existsSync("packages/db") ? "." : "../..";

/** Both journals. The cloud one is `packages/db/drizzle`; the shared mail one is `db-mail`'s. */
const JOURNAL_DIRS = [
  "packages/db-mail/drizzle",
  "packages/db/drizzle",
];

const MARKER = "--> statement-breakpoint";

/**
 * How many TOP-LEVEL statements this SQL text contains.
 *
 * A single-pass lexer over the five things that can contain a semicolon without ending a
 * statement. Trailing whitespace after the last `;` is not a statement, and neither is a chunk of
 * pure comment — both are what the `+ (tail has content)` term at the end decides.
 */
export function countStatements(sql: string): number {
  let i = 0;
  let depth = 0;
  let statements = 0;
  let sinceLast = "";   // text seen since the last `;`, to tell "a real statement" from whitespace

  while (i < sql.length) {
    const c = sql[i]!;
    const two = sql.slice(i, i + 2);

    // -- line comment
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    // /* block comment */ — Postgres nests these, so track depth.
    if (two === "/*") {
      let nest = 1;
      i += 2;
      while (i < sql.length && nest > 0) {
        if (sql.slice(i, i + 2) === "/*") { nest += 1; i += 2; continue; }
        if (sql.slice(i, i + 2) === "*/") { nest -= 1; i += 2; continue; }
        i += 1;
      }
      continue;
    }
    // $tag$ … $tag$ — a dollar-quoted body. THE ONE THAT MATTERS for this repo's history.
    if (c === "$") {
      const m = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        sinceLast += "x";
        continue;
      }
    }
    // 'literal' — '' is an escaped quote, not a terminator.
    if (c === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      sinceLast += "x";
      continue;
    }
    // "identifier" — "" is an escaped quote.
    if (c === '"') {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i += 1; break; }
        i += 1;
      }
      sinceLast += "x";
      continue;
    }

    if (c === "(") depth += 1;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      if (sinceLast.trim().length > 0) statements += 1;
      sinceLast = "";
      i += 1;
      continue;
    }

    sinceLast += c;
    i += 1;
  }

  // A final statement with no trailing semicolon still counts.
  return statements + (sinceLast.trim().length > 0 ? 1 : 0);
}

interface Offender { file: string; chunk: number; statements: number }

function auditDir(dir: string): Offender[] {
  const abs = join(HERE, dir);
  if (!existsSync(abs)) return [];
  const out: Offender[] = [];
  for (const name of readdirSync(abs).filter((n) => n.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(abs, name), "utf8");
    sql.split(MARKER).forEach((chunk, idx) => {
      const n = countStatements(chunk);
      if (n > 1) out.push({ file: `${dir}/${name}`, chunk: idx, statements: n });
    });
  }
  return out;
}

describe("every migration chunk holds at most one statement", () => {
  for (const dir of JOURNAL_DIRS) {
    it(`${dir} — no chunk sends two commands in one prepared statement`, () => {
      const offenders = auditDir(dir);
      expect(
        offenders,
        offenders.length === 0 ? "" : `these chunks would be refused by Postgres with `
          + `"cannot insert multiple commands into a prepared statement" — add `
          + `${MARKER} between the statements:\n`
          + offenders.map((o) => `  ${o.file} chunk #${o.chunk}: ${o.statements} statements`).join("\n"),
      ).toEqual([]);
    });
  }

  it("the journals are actually there — a scanner that finds no files is not a passing guard", () => {
    const counted = JOURNAL_DIRS.map((d) => {
      const abs = join(HERE, d);
      return existsSync(abs) ? readdirSync(abs).filter((n) => n.endsWith(".sql")).length : 0;
    });
    // The "a green that means nothing" failure this repo has already paid for twice: a census whose
    // directory moved reports success for ever. Both journals hold real files, asserted by count.
    for (const n of counted) expect(n).toBeGreaterThan(10);
  });

  it("0087 — the migration that found this defect — is well-formed", () => {
    const sql = readFileSync(join(HERE, "packages/db-mail/drizzle/0087_away_reply_throttle.sql"), "utf8");
    const chunks = sql.split(MARKER);
    expect(chunks.length).toBeGreaterThan(1);
    for (const [i, chunk] of chunks.entries()) {
      expect(countStatements(chunk), `0087 chunk #${i}`).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * THE SCANNER IS NOT THE HOLE IT CLOSES — the same discipline `pass-registry.test.ts` applies to
 * its comment stripper, and it matters more here: a counter that is too EAGER condemns 38 existing
 * migrations (and gets deleted), while one that is too LAZY passes the exact file shape it exists
 * to catch.
 */
describe("the statement counter", () => {
  it("counts plain statements", () => {
    expect(countStatements("SELECT 1;")).toBe(1);
    expect(countStatements("SELECT 1; SELECT 2;")).toBe(2);
    expect(countStatements("SELECT 1;\nSELECT 2;\nSELECT 3;")).toBe(3);
  });

  it("counts a final statement with no trailing semicolon", () => {
    expect(countStatements("SELECT 1")).toBe(1);
    expect(countStatements("SELECT 1;\nSELECT 2")).toBe(2);
  });

  it("does not count comments or whitespace as statements", () => {
    expect(countStatements("")).toBe(0);
    expect(countStatements("\n\n  \n")).toBe(0);
    expect(countStatements("-- just a comment\n")).toBe(0);
    expect(countStatements("/* a block\n   comment */\n")).toBe(0);
    expect(countStatements("-- a note about ; semicolons\nSELECT 1;")).toBe(1);
  });

  it("ignores semicolons inside string literals and quoted identifiers", () => {
    expect(countStatements("SELECT 'a;b';")).toBe(1);
    expect(countStatements(`SELECT "we;ird";`)).toBe(1);
    // '' is an escaped quote, so the string does not end there.
    expect(countStatements("SELECT 'it''s; fine';")).toBe(1);
  });

  /**
   * THE ONE THAT DECIDES WHETHER THIS GUARD IS USABLE AT ALL. 38 migrations in this repo carry
   * `$$` bodies stuffed with semicolons; without this branch every one of them reads as a dozen
   * statements and the guard condemns the entire history.
   */
  it("ignores semicolons inside dollar-quoted bodies, tagged and untagged", () => {
    expect(countStatements("CREATE FUNCTION f() RETURNS void AS $$ BEGIN a; b; c; END $$;")).toBe(1);
    expect(countStatements("CREATE FUNCTION f() RETURNS void AS $body$ a; b; $body$;")).toBe(1);
    expect(countStatements("DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;")).toBe(1);
  });

  it("ignores a semicolon inside a parenthesised group", () => {
    expect(countStatements("CREATE TABLE t (\n  a text,\n  b text\n);")).toBe(1);
  });

  /**
   * THE PLANTED DEFECT, watched red — a two-statement file with no marker between them, which is
   * exactly the shape 0087 shipped in. If this returns 1, the guard above is decorative.
   */
  it("CATCHES the planted defect: two statements, no marker", () => {
    const planted = [
      'ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "a" text;',
      'ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "b" text;',
    ].join("\n");
    // No marker between them: one chunk, two statements — refused by Postgres.
    expect(planted.split(MARKER)).toHaveLength(1);
    expect(countStatements(planted)).toBe(2);

    // The same two statements WITH the marker: two chunks, one statement each.
    const fixed = planted.split("\n").join(`${MARKER}\n`);
    const chunks = fixed.split(MARKER);
    expect(chunks).toHaveLength(2);
    for (const c of chunks) expect(countStatements(c)).toBeLessThanOrEqual(1);
  });
});
