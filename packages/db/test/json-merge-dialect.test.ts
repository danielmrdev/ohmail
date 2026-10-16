import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { dialect, SQL_TRIM_BLANK } from "../src/dialect/index.js";
import { ELEMENT_CASES, FOLD_CASES, IS_ARRAY_CASES, MERGE_CASES } from "./_dialect-json-cases.js";

/**
 * THE JSON MEMBERS, EXECUTED BY WHICHEVER STORE THIS RUN OPENED — one file, two runs.
 *
 * Every construct here was written inline in a file the phone's own bundle loads, in the server's
 * spelling, and each failed differently on the device store rather than not at all:
 *
 *   · `coalesce(meta, '{}'::jsonb) || patch::jsonb` — `||` is string CONCATENATION there, so the
 *     credential blob would have been two JSON documents stuck end to end. Nothing fails at the
 *     write; the row simply stops parsing, which is the worst of the three;
 *   · `jsonb_array_elements` / `jsonb_typeof` / `#>>` — no such function or operator;
 *   · `btrim` — no such function, in the one predicate every message DTO evaluates.
 *
 * Table-free on purpose: these are EXPRESSIONS, so nothing here needs a schema, and a file that
 * seeds no rows answers the same question on both stores without two fixtures to keep in step.
 *
 * ── WATCHED FAIL ──────────────────────────────────────────────────────────────────────────
 *
 * With the SQLite arm of `jsonMergeShallow` replaced by the server's `||`, the merge cases answer
 * `{}{"host":"h"}` — not an error, a document that parses as nothing — and the Postgres run stays
 * green. With `isString` taken from `json_type(value)` instead of `json_each`'s own `type` column,
 * the element cases die with `malformed JSON`. Neither mutation is visible to the other store.
 */
type TestDb = Awaited<ReturnType<typeof makeTestDb>>;

/** One scalar, positionally — the only row shape both drivers can produce honestly. */
async function one(db: TestDb, expr: ReturnType<typeof sql>): Promise<unknown> {
  const rows = await dialect(db).exec(db, sql`select ${expr}`);
  expect(rows.length, "the probe returned no row").toBe(1);
  return rows[0]![0];
}

/** One store answers a boolean, the other a 0/1 integer — a driver difference, not a dialect. */
const truthy = (v: unknown): boolean => v === true || v === 1;

describe("a shallow JSON merge, on whichever store this is", () => {
  for (const c of MERGE_CASES) {
    it(`merges: ${c.what}`, async () => {
      const db = await makeTestDb();
      const d = dialect(db);
      const merged = await one(db, d.jsonMergeShallow(
        c.document === null ? sql`${null}` : sql`${c.document}`, sql`${c.patch}`,
      ));
      // Parsed rather than compared as text, and that is the honest comparison: the server sorts
      // a jsonb object's keys and this store keeps insertion order, so the two documents are
      // equal and their bytes are not. Every caller reads the column back through a JSON parse.
      const got = typeof merged === "string" ? JSON.parse(merged) : merged;
      expect(got).toEqual(c.expected);
    });
  }
});

describe("the value at one JSON key, and whether it is an array", () => {
  for (const c of IS_ARRAY_CASES) {
    it(`answers ${c.isArray} for ${c.what}`, async () => {
      const db = await makeTestDb();
      const d = dialect(db);
      // CAST, because a bare parameter has no type for the server to resolve `->` against
      // (`operator is not unique: unknown -> unknown`). Every real caller hands this member a
      // jsonb COLUMN, so the cast is the fixture standing in for one, not a member requirement
      // the callers do not meet.
      const doc = d.castJsonb(sql`${c.document}`);
      const v = await one(db, d.jsonIsArray(d.jsonGet(doc, c.key)));
      // A missing key yields SQL NULL through `jsonGet` on both stores, so the predicate is NULL
      // and reads as false — which is what every caller's `case when` does with it.
      expect(truthy(v)).toBe(c.isArray);
    });
  }

  it("refuses a key it cannot address on both stores, rather than reading the wrong path", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    expect(() => d.jsonGet(sql`'{}'`, 'a"b')).toThrow(/quote or a backslash/);
    expect(() => d.jsonGet(sql`'{}'`, "a\\b")).toThrow(/quote or a backslash/);
    // POSITIVE CONTROL: the keys this schema really holds are admitted. A refusal rule with no
    // admitted case is a rule that could be refusing everything.
    expect(() => d.jsonGet(sql`'{}'`, "x-auto-response-suppress")).not.toThrow();
  });
});

describe("a JSON array's elements, with the type test the caller depends on", () => {
  for (const c of ELEMENT_CASES) {
    it(`reads the string members of ${c.what}`, async () => {
      const db = await makeTestDb();
      const d = dialect(db);
      const el = d.jsonArrayElements(d.jsonGet(d.castJsonb(sql`${c.document}`), c.key), "el");
      const rows = await d.exec(db, sql`
        select ${el.text} from ${el.from} where ${el.isString}`);
      expect(rows.map((r) => r[0])).toEqual([...c.strings]);
    });
  }
});

describe("the blank set both stores can strip, and substring containment", () => {
  for (const c of FOLD_CASES) {
    it(`${JSON.stringify(c.value)}: not-no ${c.notNo}, precedence ${c.precedence}`, async () => {
      const db = await makeTestDb();
      const d = dialect(db);
      const folded = sql`lower(trim(${c.value}, ${SQL_TRIM_BLANK}))`;
      expect(truthy(await one(db, sql`${folded} <> 'no'`)), "the not-no arm").toBe(c.notNo);
      const holds = ["bulk", "autoreply", "auto_reply", "junk", "list"]
        .map((n) => sql`${d.strpos(folded, sql`${n}`)} > 0`);
      const anyHolds = sql`(${sql.join(holds, sql` or `)})`;
      expect(truthy(await one(db, anyHolds)), "the precedence arm").toBe(c.precedence);
    });
  }
});
