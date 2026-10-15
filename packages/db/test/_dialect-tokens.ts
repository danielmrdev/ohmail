import {
  censusableSpans, inServerArm, lineOf, pgOnlyCalls, serverArmRanges,
} from "./_dialect-ast.js";

/**
 * THE CONSTRUCTS THE TWO STORES SPELL DIFFERENTLY — and the ONE question this census asks.
 *
 * **Does this file hand the STORE a construct only Postgres accepts?** Everything below follows
 * from that sentence, and the tables are split by how a file can do it — because a pattern that
 * answers a DIFFERENT question is not a stricter census, it is a census measuring the wrong thing.
 *
 * ── WHY THE SPLIT, MEASURED ───────────────────────────────────────────────────────────────
 *
 * These tables were once scanned over the whole file, and the first zero-allowance census over the
 * phone's bundle reported 364 hits in 63 files. Three quarters of them were not SQL:
 *
 *   · 188 were PROSE — a comment naming the server's spelling, which is what a comment at a
 *     dialect seam is FOR;
 *   · 48 were the JavaScript clock. `now()` is spelled identically in the two languages and this
 *     table's own comment used to claim the leading dot told them apart. That is true of
 *     `Date.now()` and false of the injected clock this codebase passes everywhere and calls as a
 *     bare `now()`. `apps/sidecar/src/engine.ts` read as carrying 23 and carries THREE;
 *   · ~14 were JavaScript punctuation — a regex alternation `?|`, an IPv6 `::ffff:` — in files with
 *     no SQL in them at all.
 *
 * A census whose findings are mostly noise gets muted, and a muted census is indistinguishable from
 * a passing one. So the fix is the same one already made for `d.greatest(` one level down: name the
 * consumer, and stop counting what the consumer never sees.
 *
 * ── THE TWO CLASSES ───────────────────────────────────────────────────────────────────────
 *
 * 1. {@link SQL_CONTEXT_TOKENS} — the construct is in the SQL TEXT a file emits, so it is scanned
 *    over `sqlTemplates` output and nothing else. Inside a tagged template there is no prose and no
 *    JavaScript, so `now()` there means exactly one thing. Prose and the clock leave BY
 *    CONSTRUCTION rather than by a lookbehind that has to be got right.
 * 2. {@link DIALECT_TOKENS} — the construct is a BUILDER CALL that renders Postgres-only SQL. No
 *    template contains it; the query builder writes the clause. These are scanned over the whole
 *    file with comments STRIPPED, because prose about a row lock is still prose.
 *
 * And {@link RATCHET_TOKENS} is neither: `db.execute(` names a MECHANISM (a raw statement handed to
 * the driver), not a dialect. Its text is already censused by the template scan, so counting it in
 * the phone's census would double-count every raw statement — and score a ported one twice. It is
 * kept for the desktop ratchet, where "how many raw statements does the engine still carry" is a
 * number worth not letting grow.
 */
export const DIALECT_TOKENS: Readonly<Record<string, RegExp>> = {
  /**
   * THE ROW LOCK AS THE QUERY BUILDER SPELLS IT — `q.for("update", …)`.
   *
   * The clause never appears as text: the builder appends it. So this one cannot be found by
   * scanning SQL, and it is exactly the construct the device store's builder does not have
   * ("base.for is not a function"), which is a crash and not a wrong answer.
   */
  "for(update) builder": /\.for\(\s*["'](?:update|share|no key update|key share)["']/gi,
  /**
   * The builder's own skip-locked option, and NOT the seam's option of the same name.
   *
   * `{ skipLocked: true }` is spelled identically in both places — it is drizzle's option AND the
   * seam's `LockOptions` field — so shape alone cannot tell them apart, and a bare pattern counted
   * `d.forUpdate(q, { skipLocked: true })`, the PORTED form, as the construct. What distinguishes
   * them is WHERE the object sits: drizzle's is the second argument of `.for(…)`, and the only way
   * to ask that builder for skip-locked at all. So the pattern requires the call around it.
   *
   * The second alternative is a bare `skipLocked(` call with no receiver, which the seam's member
   * (`d.skipLocked(q)`) is never written as.
   */
  "skipLocked builder": /\.for\(\s*["'][^"']*["']\s*,\s*\{[^}]*skipLocked\s*:\s*true|(?<![.\w])skipLocked\s*\(/g,
  /**
   * Drizzle's `DISTINCT ON`, which only Postgres has and which no template text carries.
   *
   * NO leading-dot guard, unlike the two above, and the difference is a fact rather than a style:
   * the builder call IS `q.distinctOn(…)`, and the seam has no member of that name for the guard to
   * protect. Written with one first, it matched nothing at all.
   *
   * AND THE CALL IS ALSO SPELLED `selectDistinctOn(`, which a word boundary before `distinctOn`
   * cannot see — the `d` there follows a letter. Two sites in the engine use that form and censused
   * as carrying nothing.
   */
  "distinctOn builder": /\b(?:select)?[Dd]istinctOn\s*\(/g,

  /**
   * A RAW STATEMENT HANDED TO THE DRIVER — counted here because the METHOD is the construct.
   *
   * `db.execute(` is also a RATCHET token, on the reasoning that it names a mechanism whose SQL the
   * query-text scan already censuses. That is true of the SQL and false of the CALL: the device
   * store's handle has no `execute` at all, so a surviving one is `TypeError: db.execute is not a
   * function`, naming neither the store nor the statement. It was found exactly that way — a pass
   * dying on a phone bundle whose dialect census was green, reporting its own failure as an empty
   * object because `JSON.stringify` of an `Error` is `{}`. The seam's `exec(db, statement)` is the
   * ported form, and its rows are positional on both stores.
   *
   * EXCEPT INSIDE A DECLARED ARM, and that is a question about the BRANCH rather than about the
   * call. It used to be a lookahead for `pgOnly(` in the pattern itself, which exempted the marker
   * wherever it was written — including in a file with no branch at all. The arm filter in
   * {@link countTokens} asks where the call IS, so the three catalog probes stay clean and a
   * marker with nothing behind it does not.
   */
  "raw execute": /\b(?:db|tx)\.execute\s*(?:<[^()]*?>)?\s*\(/g,
} as const;

/**
 * A RAW STATEMENT HANDED TO THE DRIVER — a mechanism, not a dialect. See the banner above.
 *
 * The optional `<…>` is not decoration. Without it the pattern could not match
 * `tx.execute<{ bytes: string }>(`, and a generic-typed call is the ordinary spelling wherever the
 * caller reads columns back: five of the thirty in the engine's own sources carry one, and two of
 * the three files holding them censused as carrying NONE. Bounded on parentheses because a type
 * argument never contains one, so the lazy run cannot wander past the call it belongs to.
 */
export const RATCHET_TOKENS: Readonly<Record<string, RegExp>> = {
  "db.execute(": /\b(?:db|tx)\.execute\s*(?:<[^()]*?>)?\s*\(/g,
} as const;

/**
 * CONSTRUCTS IN THE SQL A FILE EMITS — scanned over the tagged-template text alone.
 *
 * `~` was the case that forced this table into existence and the reasoning turned out to cover
 * almost all of it: as a SQL operator it is a Postgres regex match with no equivalent here, and as
 * a character it is a JavaScript bitwise NOT, a path shorthand and ordinary punctuation in prose.
 * Both facts are true at once, and the way to have both is to stop scanning the whole file. Inside
 * a `sql` template there is no prose and no JavaScript operator — there is only SQL.
 */
export const SQL_CONTEXT_TOKENS: Readonly<Record<string, RegExp>> = {
  /** The clause as TEXT. The builder's spelling is `for(update) builder` in the table above. */
  "FOR UPDATE": /\bfor\s+(?:update|share|no\s+key\s+update|key\s+share)\b/gi,
  "SKIP LOCKED": /\bskip\s+locked\b/gi,
  "pg_advisory": /pg_advisory\w*/g,
  "pg_notify": /pg_notify/g,
  // Any cast, not an enumerated few: the list was the thing that had to be kept in step, and it
  // was not — `::varchar`, `::smallint`, `::double precision` and `::inet` all read as portable.
  "cast": /::\s*"?[a-z][a-z_ ]*"?(?:\[\])?/g,
  "ILIKE": /\bilike\b/gi,
  /**
   * The server's current instant.
   *
   * No lookbehind, and that is the point: inside a statement there is no JavaScript clock to tell
   * it apart from. The guard used to be `(?<![.\w])` scanned file-wide, which caught `Date.now()`
   * and missed the injected `now()` this codebase actually uses — 48 false hits, and one file
   * reading as the largest item in the burn-down while carrying three real ones.
   */
  "now()": /\bnow\(\)/g,
  "INTERVAL": /\binterval\s+'/gi,
  "DISTINCT ON": /\bdistinct\s+on\b/gi,
  "to_tsvector": /to_tsvector|tsvector|websearch_to_tsquery|ts_rank|to_tsquery/g,
  "ON CONFLICT ON CONSTRAINT": /on\s+conflict\s+on\s+constraint/gi,
  "word_similarity": /word_similarity/g,
  /**
   * THE ROW-VISIBILITY COLUMN, which is how the server answers "did this statement insert the row".
   *
   * It has no equivalent anywhere else and it is not a spelling difference — it is a fact about one
   * store's transaction machinery. A statement carrying it fails on the device store at once, with
   * `no such column: xmax`, which is why the ONE place the engine uses it is a declared arm rather
   * than a port (see {@link sqlTemplates} and the census's `pgOnly(` pin).
   */
  "xmax": /\bxmax\b/g,
  /**
   * Functions this store has under another name, or not at all.
   *
   * `greatest`/`least` are `max`/`min` here, `date_trunc` and `extract(epoch …)` have no
   * equivalent, and `gen_random_uuid` is the one the device twin hand-rolls. The seam's own
   * Postgres arm uses `greatest`, which is how the gap was found. Scanned over query text, so the
   * seam MEMBERS that share these names (`d.greatest`, `d.least`, `d.strpos`) are outside it by
   * construction — they are JavaScript, and the guard that used to be needed for them is now the
   * table they are not in.
   *
   * ── THE SEVEN THIS LIST DID NOT HOLD, AND HOW THEY WERE FOUND ─────────────────────────────
   *
   * `btrim`, `char_length`, `left`, `right`, `to_timestamp`, `to_jsonb` and `jsonb_set` were
   * missing, and the phone's bundle carried EIGHT calls to them across four files while both arms
   * of this census read zero. Found by grepping the built bundle for `btrim` after the burn-down
   * closed — not by reading this list, which is the argument for measuring a table against an
   * artifact rather than against itself. `btrim` was the sharpest: the predicate every message DTO
   * evaluates called it, so a device would have failed on its first mailbox screen.
   *
   * Each has a counterpart under a name BOTH stores have (`trim`, `length`, `substr`, the seam's
   * `ts` and `jsonObject`/`jsonMergeShallow`), which is why adding them raised no pin: the sites
   * moved in the same edit.
   */
  "pg-only function": /\b(?:date_trunc|age|make_interval|greatest|least|gen_random_uuid|uuid_generate_v\d|array_agg|array_length|string_agg|string_to_array|bool_or|bool_and|strpos|to_char|btrim|char_length|left|right|overlay|to_timestamp|regexp_replace|regexp_matches|unnest|generate_series|jsonb_object_keys|jsonb_array_elements|jsonb_each|jsonb_build_object|jsonb_agg|to_jsonb|jsonb_set|jsonb_insert|jsonb_strip_nulls|row_to_json|to_regprocedure)\s*\(|extract\s*\(\s*epoch|=\s*any\s*\(/gi,
  /**
   * OPERATORS, which the function list could never have caught: JSON containment and the regex
   * operators are Postgres-only and spelled entirely in punctuation.
   */
  "pg-only operator": /@>|<@|#>>|#>|\?\||\?&|!~\*?|~\*/g,
  // Bare `~` only. The negated and case-insensitive forms are in the line above.
  "regex match (~)": /(?<![!~])~(?![~*])/g,
  /**
   * THE SINGLE `?` — JSON KEY-EXISTS, and the most dangerous construct in the whole table.
   *
   * On the device store `?` is not an operator at all, it is a PARAMETER PLACEHOLDER — so a
   * statement carrying one does not fail, it consumes the next bound value into the wrong position
   * and shifts every binding after it. A wrong answer, silently, in a statement that ran. Matched
   * only where a quoted key follows, which is the shape the operator takes and a placeholder never
   * has.
   */
  "json key exists (?)": /\?\s*'/g,
  /**
   * SQL-STANDARD SPELLINGS THIS STORE DOES NOT HAVE — `position(x IN y)`, `substring(x FROM n)`.
   *
   * Both are syntax rather than functions: the argument separator is a KEYWORD, which is why no
   * list of function names could ever have caught them.
   */
  "position(x in y)": /\bposition\s*\([^()]*\bin\b/gi,
  "substring(x from n)": /\bsubstring\s*\([^()]*\bfrom\b/gi,
};

/**
 * A file's source with every comment blanked out — for BOTH tables.
 *
 * A scanner rather than two regular expressions, because a `//` inside a string literal is not a
 * comment and truncating the line there would HIDE the rest of it. A census that under-counts
 * because of its own stripper is the failure this whole file is about.
 *
 * ── IT BLANKS RATHER THAN DELETES, AND THAT IS LOAD-BEARING TWICE ─────────────────────────
 *
 * Every character is replaced by a space and every newline is kept, so the result is the same
 * LENGTH and the same shape as the input. That is what lets the query-text scan run over this
 * instead of over the raw file while still citing real line numbers — and it has to run over this,
 * because a `sql` template written INSIDE a comment is prose too. `schema-mail-sqlite.ts` carries
 * one: a comment saying *"never `sql`now()``"*, which the census read as the device schema emitting
 * the server's clock. The rule the file states and the construct the census found were the same
 * sentence.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out += source[k] === "\n" ? "\n" : " ";
  };
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < source.length) {
        const c = source[i];
        out += c;
        i++;
        if (c === "\\") { if (i < source.length) { out += source[i]; i++; } continue; }
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * The SQL a file emits that a DEVICE STORE could reach — read from the AST, declared arms removed.
 *
 * Two readings in one, and both were patterns over source before: which text is SQL (a `sql`
 * tagged template, or a raw SQL string handed to the driver), and which of it a device never
 * reaches (a declared branch's server arm). `fileName` only chooses the parser's script kind —
 * the bundle loads plain JavaScript shims as well as TypeScript.
 */
export function sqlTemplates(source: string, fileName?: string): string[] {
  return censusableSpans(source, fileName).map((s) => s.text);
}

/**
 * THE OLD READER, KEPT AS THE CONTROL — the pattern over source, with its own answer.
 *
 * It exists to be DISAGREED WITH. The census pins the files where the two readings differ, so the
 * day the AST starts reading nothing — a parse it recovers from, a tag spelled a new way — that is
 * a red naming the file rather than a quiet zero. It is never the census's own answer.
 */
export function textSqlTemplates(source: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  for (const m of code.matchAll(/\bsql(?:\.raw)?(?:<[^<>()]*>)?`/g)) {
    if (/pgOnly\(\s*$/.test(code.slice(Math.max(0, m.index - 40), m.index))) continue;
    let text = "";
    let depth = 0;
    for (let i = m.index + m[0].length; i < code.length; i++) {
      const ch = code[i] as string;
      if (ch === "\\") { i++; continue; }
      if (depth === 0 && ch === "`") break;
      if (ch === "$" && code[i + 1] === "{") { depth++; i++; continue; }
      if (depth > 0) { if (ch === "{") depth++; else if (ch === "}") depth--; continue; }
      text += ch;
    }
    out.push(text);
  }
  return out;
}

/**
 * The 1-based lines where `pattern` matches SQL a device store could reach.
 *
 * Exact rather than line-granular, and the difference was measured: testing whole LINES against a
 * query-text token named every line that merely CONTAINS a template, so a `.set({ bytes: sql`…`,
 * updatedAt: d.now() })` was cited for `now()` — a ported line, reported as debt.
 */
export function sqlHitLines(source: string, pattern: RegExp, fileName?: string): number[] {
  const at = lineOf(source);
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const lines = new Set<number>();
  for (const span of censusableSpans(source, fileName)) {
    for (const m of span.text.matchAll(new RegExp(pattern.source, flags))) {
      lines.add(at(span.offsets[m.index] ?? 0));
    }
  }
  return [...lines].sort((a, b) => a - b);
}

/** Is this token scanned over the SQL a file emits, rather than over the file? */
export function isSqlContextToken(token: string): boolean {
  return Object.hasOwn(SQL_CONTEXT_TOKENS, token);
}

/**
 * The DECLARED Postgres-only arms in a file — a `pgOnly(` inside a branch a device never enters.
 *
 * The marker alone was treated as the declaration, and it is not one: written anywhere at all it
 * exempted the statement it wrapped, which is an allowance wearing a marker's clothes. The BRANCH
 * is what keeps the device store away from the construct, so the branch is what this reads. A
 * marker with no branch behind it is {@link undeclaredPgOnlyLines} — a red naming the line.
 */
export function pgOnlySites(source: string, fileName?: string): number {
  return pgOnlyCalls(source, fileName).filter((c) => c.declared).length;
}

/** A `pgOnly(` outside every declared arm: a marker claiming an exemption nothing enforces. */
export function undeclaredPgOnlyLines(source: string, fileName?: string): number[] {
  return pgOnlyCalls(source, fileName).filter((c) => !c.declared).map((c) => c.line);
}

/**
 * WHAT THIS CENSUS DOES NOT ASK ABOUT — the seam, and two modules a device never runs.
 *
 * `packages/db/src/dialect/` is the seam whose whole job is knowing the difference.
 *
 * The other two are SERVER-ONLY and are not ports:
 *
 *   · `baseline.ts` adopts the POSTGRES migration journal — it asks `information_schema.tables`
 *     whether `__drizzle_migrations` exists and stamps rows into it. A device runs a different
 *     journal through a different migrator, so this module has no work to do there.
 *   · `mailbox-dedup.ts` reads `information_schema.columns` and `pg_indexes` to decide what shape
 *     the schema is in. Those are Postgres catalogs; the device store's catalog is `sqlite_master`
 *     and `pragma table_info`, which is a different question and not a different spelling.
 *
 * AN EXCLUSION IS A CLAIM, so it has a guard rather than a comment.
 * `server-only-modules.test.ts` walks the import graph from the entry points a device's
 * composition goes through and asserts neither module is reachable — watched fail by exporting
 * one of them from the barrel every service imports, which names the chain. Without that, the day
 * something on a phone grows an import of one of these, the census that would have objected has
 * been told not to look.
 */
export const DIALECT_EXEMPT =
  /^packages\/db\/src\/(?:dialect\/|baseline\.ts$|mailbox-dedup\.ts$)/;

/**
 * Count each construct a DEVICE STORE could reach in one file's source.
 *
 * Two scans and two subjects: the builder table over the file with comments stripped, the dialect
 * table over the SQL the file emits. Both drop what lies inside a declared branch's server arm —
 * one rule, applied to every table, because a construct a device never reaches is not debt.
 * `ratchet` adds the raw-statement mechanism, which the desktop ratchet counts and the phone's
 * census must not: its text is already measured by the template scan.
 */
export function countTokens(
  source: string,
  { ratchet = false, fileName }: { ratchet?: boolean; fileName?: string } = {},
): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (name: string, n: number) => { if (n > 0) out[name] = (out[name] ?? 0) + n; };

  /* The stripper BLANKS rather than deletes, so every match offset still names a real position and
     the arm filter can ask where the construct is. */
  const code = stripComments(source);
  const arms = serverArmRanges(source, fileName);
  const reachable = (m: RegExpMatchArray) => !inServerArm(arms, m.index ?? 0);
  for (const table of ratchet ? [DIALECT_TOKENS, RATCHET_TOKENS] : [DIALECT_TOKENS]) {
    for (const [name, pattern] of Object.entries(table)) {
      add(name, [...code.matchAll(new RegExp(pattern.source, pattern.flags))].filter(reachable).length);
    }
  }

  const queries = sqlTemplates(source, fileName).join("\n");
  for (const [name, pattern] of Object.entries(SQL_CONTEXT_TOKENS)) {
    add(name, (queries.match(new RegExp(pattern.source, pattern.flags)) ?? []).length);
  }
  return out;
}

/** The pattern behind a token name, whichever table owns it — for a failure that prints lines. */
export function patternFor(token: string): RegExp | undefined {
  return DIALECT_TOKENS[token] ?? RATCHET_TOKENS[token] ?? SQL_CONTEXT_TOKENS[token];
}
