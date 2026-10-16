import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAIL_MIGRATIONS_DIR, SQLITE_MIGRATIONS_DIR } from "@ohmail/db-mail";
import { CLOUD_MIGRATIONS_DIR } from "../src/journal-specs.js";

/**
 * NO ENTRY MAY DROP A TABLE ANOTHER TABLE STILL REFERENCES — unless somebody said why.
 *
 * The two stores fail this differently and only one of them fails quietly. PostgreSQL REFUSES the
 * drop while a dependent key exists, so such an entry never applies. SQLite performs an implicit
 * DELETE FROM instead, and every ON DELETE CASCADE child loses its rows — which is why the
 * migrator now runs the documented dance around every entry (`sqlite-rebuild-keeps-its-children`).
 *
 * This census is the other half: it reads all three journals as they stand and refuses a NEW such
 * entry by name. The pinned list may only shrink.
 */

/**
 * Comments, string literals and dollar-quoted bodies blanked to spaces, one left-to-right pass.
 *
 * Its own scanner and not `normalizeSql`: that one keeps literal spans verbatim, which is right for
 * deciding a migration's identity and wrong here — a `DROP TABLE public.%I` inside a `format()`
 * string read as a statement of this file — and it collapses the text to one line, where the
 * breakpoint marker's own `--` then blanks every statement after the first. It runs on the RAW
 * text. Double-quoted spans are KEPT: those are identifiers, which is what is being read.
 */
function executableOnly(src: string): string {
  const out = src.split("");
  const blank = (i: number) => { if (src[i] !== "\n") out[i] = " "; };
  for (let i = 0; i < src.length;) {
    const two = src.slice(i, i + 2);
    if (two === "--") { while (i < src.length && src[i] !== "\n") blank(i++); continue; }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      while (i < stop) blank(i++);
      continue;
    }
    if (src[i] === "'") {
      blank(i++);
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") { blank(i); blank(i + 1); i += 2; continue; }
        if (src[i] === "'") { blank(i++); break; }
        blank(i++);
      }
      continue;
    }
    const tag = /^\$[A-Za-z_]*\$/.exec(src.slice(i, i + 40));
    if (tag) {
      const end = src.indexOf(tag[0], i + tag[0].length);
      const stop = end === -1 ? src.length : end + tag[0].length;
      while (i < stop) blank(i++);
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * An entry whose DROP is composed at RUN TIME inside a dollar-quoted body. This census cannot read
 * one, so it refuses it rather than reading past it — the reason is stated here by hand.
 */
const DYNAMIC_DROPS: Record<string, string> = {
  "0032_retire_billing_tables.sql":
    "the billing retirement drops its tables through `EXECUTE format('DROP TABLE public.%I', t)`; " +
    "the tables it names are the private plane's and nothing in these journals references them",
};

/** An entry that drops a table something references, admitted with the reason it is safe. */
const DANCE_COVERED: Record<string, string> = {
  "0095_outbound_send_resolution.sql":
    "the one rebuild in the device journal; `outbound_send_fingerprints` cascades from " +
    "`outbound_sends`, and the migrator's foreign-keys-off dance is what keeps its rows — see " +
    "sqlite-rebuild-keeps-its-children.test.ts, which loses the row without it",
};

const JOURNALS = [
  ["mail", MAIL_MIGRATIONS_DIR],
  ["cloud", CLOUD_MIGRATIONS_DIR],
  ["sqlite", SQLITE_MIGRATIONS_DIR],
] as const;

const ident = String.raw`(?:"([a-z0-9_]+)"|([a-z0-9_]+))`;
const name = (a?: string, b?: string): string => (a ?? b ?? "").toLowerCase();

/**
 * Walk one journal in order and answer every drop of a still-referenced table.
 *
 * The reference graph is built as the journal runs, not read off the final schema: a table dropped
 * in entry 40 and recreated in entry 41 is referenced by different tables at each point.
 */
export function dropsOfReferencedTables(
  entries: readonly { name: string; sql: string }[],
): { entry: string; dropped: string; referencedBy: string[] }[] {
  /** child -> the parents it references, as the journal stands at this point. */
  const refs = new Map<string, Set<string>>();
  const found: { entry: string; dropped: string; referencedBy: string[] }[] = [];
  for (const e of entries) {
    const sql = executableOnly(e.sql);
    for (const m of sql.matchAll(new RegExp(String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${ident}`, "gi"))) {
      const dropped = name(m[1], m[2]);
      const by = [...refs].filter(([c, ps]) => c !== dropped && ps.has(dropped)).map(([c]) => c).sort();
      if (by.length > 0) found.push({ entry: e.name, dropped, referencedBy: by });
      refs.delete(dropped);
    }
    // `CREATE TABLE "x" ( … REFERENCES "y" … )` — every parent named inside one table's body.
    for (const m of sql.matchAll(new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${ident}\s*\(`, "gi"))) {
      const child = name(m[1], m[2]);
      const body = sql.slice(m.index + m[0].length, sql.indexOf(";", m.index));
      const parents = new Set<string>();
      for (const r of body.matchAll(new RegExp(String.raw`REFERENCES\s+${ident}`, "gi"))) {
        parents.add(name(r[1], r[2]));
      }
      refs.set(child, parents);
    }
    for (const m of sql.matchAll(
      new RegExp(String.raw`ALTER\s+TABLE\s+${ident}[^;]*?REFERENCES\s+${ident}`, "gi"),
    )) {
      const child = name(m[1], m[2]);
      const parent = name(m[3], m[4]);
      refs.set(child, (refs.get(child) ?? new Set()).add(parent));
    }
    for (const m of sql.matchAll(
      new RegExp(String.raw`ALTER\s+TABLE\s+${ident}\s+RENAME\s+TO\s+${ident}`, "gi"),
    )) {
      const from = name(m[1], m[2]);
      const to = name(m[3], m[4]);
      if (refs.has(from)) { refs.set(to, refs.get(from) as Set<string>); refs.delete(from); }
    }
  }
  return found;
}

const read = (dir: string) =>
  readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => ({ name: f, sql: readFileSync(join(dir, f), "utf8") }));

/** The bodies of every dollar-quoted span, which is where run-time SQL is composed. */
function dollarBodies(src: string): string[] {
  const out: string[] = [];
  const re = /\$[A-Za-z_]*\$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const end = src.indexOf(m[0], m.index + m[0].length);
    if (end === -1) break;
    out.push(src.slice(m.index + m[0].length, end));
    re.lastIndex = end + m[0].length;
  }
  return out;
}

/** Entries whose dollar-quoted body composes a DROP this census cannot read. */
export function dynamicDrops(entries: readonly { name: string; sql: string }[]): string[] {
  return entries
    .filter((e) => dollarBodies(e.sql).some((b) => /DROP\s+TABLE/i.test(b)))
    .map((e) => e.name);
}

describe("no journal entry drops a table another table still references", () => {
  it.each(JOURNALS.map(([n, d]) => [n, d] as const))("%s: no unreadable dynamic drop", (_n, dir) => {
    // Fail closed: an entry whose DROP is composed at run time is refused, never read past.
    expect(dynamicDrops(read(dir)).filter((e) => DYNAMIC_DROPS[e] === undefined)).toEqual([]);
  });

  it("still sees the one dynamic drop the pinned list explains", () => {
    expect(dynamicDrops(read(CLOUD_MIGRATIONS_DIR))).toEqual(Object.keys(DYNAMIC_DROPS));
  });

  it.each(JOURNALS.map(([n, d]) => [n, d] as const))("%s", (_n, dir) => {
    const unexplained = dropsOfReferencedTables(read(dir))
      .filter((d) => DANCE_COVERED[d.entry] === undefined)
      .map((d) => `${d.entry} drops ${d.dropped}, still referenced by ${d.referencedBy.join(", ")}`);
    expect(unexplained).toEqual([]);
  });

  it("still sees the one entry the pinned list explains, and names its child", () => {
    // A census that stopped finding what it was written for would pass for the wrong reason.
    const found = dropsOfReferencedTables(read(SQLITE_MIGRATIONS_DIR));
    expect(found.map((f) => f.entry)).toEqual(Object.keys(DANCE_COVERED));
    expect(found[0]?.referencedBy).toEqual(["outbound_send_fingerprints"]);
  });

  it("REFUSES a planted entry that drops a referenced table, by name", () => {
    const planted = [
      { name: "0001_planted.sql", sql: `CREATE TABLE "p" ("id" text PRIMARY KEY);` },
      { name: "0002_planted.sql", sql: `CREATE TABLE "c" ("id" text PRIMARY KEY, "p_id" text REFERENCES "p"("id") ON DELETE CASCADE);` },
      { name: "0003_planted_drops_p.sql", sql: `DROP TABLE "p";` },
    ];
    const found = dropsOfReferencedTables(planted);
    expect(found).toEqual([{ entry: "0003_planted_drops_p.sql", dropped: "p", referencedBy: ["c"] }]);
    expect(DANCE_COVERED["0003_planted_drops_p.sql"]).toBeUndefined();
  });

  it("admits a drop of a table nothing references any more", () => {
    // The positive control: the child was dropped first, so the parent's drop is ordinary.
    const planted = [
      { name: "0001.sql", sql: `CREATE TABLE "p" ("id" text PRIMARY KEY);` },
      { name: "0002.sql", sql: `CREATE TABLE "c" ("id" text PRIMARY KEY, "p_id" text REFERENCES "p"("id"));` },
      { name: "0003.sql", sql: `DROP TABLE "c";--> statement-breakpoint\nDROP TABLE "p";` },
    ];
    expect(dropsOfReferencedTables(planted)).toEqual([]);
  });

  it("reads a reference added by ALTER TABLE, not only one declared at CREATE", () => {
    const planted = [
      { name: "0001.sql", sql: `CREATE TABLE "p" ("id" text PRIMARY KEY);` },
      { name: "0002.sql", sql: `CREATE TABLE "c" ("id" text PRIMARY KEY, "p_id" text);` },
      { name: "0003.sql", sql: `ALTER TABLE "c" ADD CONSTRAINT "c_p" FOREIGN KEY ("p_id") REFERENCES "p"("id");` },
      { name: "0004.sql", sql: `DROP TABLE "p";` },
    ];
    expect(dropsOfReferencedTables(planted).map((d) => d.entry)).toEqual(["0004.sql"]);
  });

  it("does not read a DROP written inside a comment", () => {
    // The two-pass strip this repository has been bitten by: the needle must be executable SQL.
    const planted = [
      { name: "0001.sql", sql: `CREATE TABLE "p" ("id" text PRIMARY KEY);` },
      { name: "0002.sql", sql: `CREATE TABLE "c" ("id" text PRIMARY KEY, "p_id" text REFERENCES "p"("id"));` },
      { name: "0003.sql", sql: `-- a rebuild would DROP TABLE "p" here, which is why it does not\nSELECT 1;` },
    ];
    expect(dropsOfReferencedTables(planted)).toEqual([]);
  });
});
