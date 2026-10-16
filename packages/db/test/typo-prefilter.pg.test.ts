import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, type SQL } from "drizzle-orm";
import { brandDialect, typoTrigramsOf } from "../src/dialect/index.js";
import { pgDialect } from "../src/dialect/pg.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * THE TYPO ARM'S CHEAP CONDITION IS NECESSARY, on real Postgres with pg_trgm: for every query and
 * document where `q <% terms` holds, `typoPrefilter` holds too, so asking it first loses no match.
 * The query's trigrams are pg_trgm's own (`show_trgm`), and a document outside ASCII passes whole:
 * pg_trgm hashes a trigram with a multibyte letter into three bytes, and `lŭ` hashes to `ock`, so
 * `lock <% lŭ` holds with no `ock` in the text. Control: the condition refuses most non-matches.
 */
const PG_UP = await realPgAvailable();
const client = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
const db = brandDialect(drizzle(client), "pg");
const THRESHOLD = 0.3;
const d = pgDialect();

/** A seeded generator, so the corpus is the same every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const WORDS = ["invoice", "quarterly", "report", "meeting", "kestrel", "portal", "anna", "hanna", "mueller",
  "zurich", "delivery", "receipt", "x", "ab", "2026", "q3", "re", "fwd", "newsletter", "kebab", "baker", "lock"];
const SEPARATORS = [" ", " ", " ", "@", ".", "-", "_", "+", ": ", " (", ") ", ", ", "#", "/"];
function corpus(): string[] {
  const r = rng(7);
  const docs: string[] = [];
  for (let i = 0; i < 400; i++) {
    const n = 1 + Math.floor(r() * 7);
    let s = "";
    for (let j = 0; j < n; j++) s += (j === 0 ? "" : SEPARATORS[Math.floor(r() * SEPARATORS.length)]) + WORDS[Math.floor(r() * WORDS.length)];
    docs.push(i % 9 === 0 ? s.toUpperCase() : s);
  }
  return [...docs, "", "a", "a b c", "grüße aus zürich", "anna müller", "lŭ", "re: lŭ kebab", "INVOICE#2026"];
}
/** One letter dropped, swapped, doubled or replaced, then whole-word and odd-shaped queries. */
function queries(): string[] {
  const r = rng(11);
  const out: string[] = [];
  for (const w of WORDS.filter((x) => x.length >= 4)) {
    const i = 1 + Math.floor(r() * (w.length - 2));
    out.push(w.slice(0, i) + w.slice(i + 1), w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2), w.slice(0, i) + w[i] + w.slice(i), w.slice(0, i) + "x" + w.slice(i + 1));
  }
  return [...out, "Invocie", "re: invoce", "quartely report", "kebap", "a", "ab", "q", "2O26", "anna-mueler", "lock", "x y"];
}

beforeAll(async () => { if (PG_UP) await client.unsafe("create extension if not exists pg_trgm"); });
afterAll(async () => { await client.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("the typo arm's cheap condition never refuses a match (real Postgres, pg_trgm)", () => {
  it("the query's trigrams are show_trgm's, and a query outside ASCII has none to give", async () => {
    for (const q of queries()) {
      const [row] = (await db.execute(sql`select show_trgm(${q}) as t`)) as unknown as Array<{ t: string[] }>;
      expect([...typoTrigramsOf(q)!].sort(), q).toEqual([...row!.t].sort());
    }
    expect(typoTrigramsOf("müller")).toBeNull();
    expect(d.search.typoPrefilter("müller", { threshold: THRESHOLD, terms: sql`d.terms`, lowered: sql`z.t` })).toBeNull();
  });

  it("every document the operator finds passes the condition, and most it does not find are refused", async () => {
    const docs = corpus();
    const values = sql.join(docs.map((t) => sql`(${t})`), sql`, `);
    let matched = 0, refusedMatch = 0, missed = 0, refused = 0, asked = 0;
    for (const q of queries()) {
      const pre = d.search.typoPrefilter(q, { threshold: THRESHOLD, terms: sql`d.terms`, lowered: sql`z.t` });
      if (pre === null) continue;
      asked++;
      const rows = (await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('pg_trgm.word_similarity_threshold', ${String(THRESHOLD)}, true)`);
        return tx.execute(sql`select count(*) filter (where hit)::int as matched, count(*) filter (where hit and not pass)::int as refused_match,
            count(*) filter (where not hit)::int as missed, count(*) filter (where not hit and not pass)::int as refused
          from (select ${q} <% d.terms as hit, ${pre as SQL} as pass from (values ${values}) d(terms)
                cross join lateral (select lower(d.terms) as t offset 0) z) x`);
      })) as unknown as Array<Record<string, number>>;
      const r = rows[0]!;
      expect(r.refused_match, `${q}: the condition refused a document the operator finds`).toBe(0);
      matched += r.matched!; refusedMatch += r.refused_match!; missed += r.missed!; refused += r.refused!;
    }
    console.log(`typo-prefilter: ${asked} queries × ${docs.length} documents, ${matched} matches kept, ${refused} of ${missed} non-matches refused`);
    expect(matched, "the corpus carries matches to lose").toBeGreaterThan(500);
    expect(refusedMatch).toBe(0);
    expect(refused / missed, "the condition refuses most of what the operator does not find").toBeGreaterThan(0.6);
  });

  it("a document outside ASCII passes whole: a hashed trigram is a match no substring shows", async () => {
    const [row] = (await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('pg_trgm.word_similarity_threshold', ${String(THRESHOLD)}, true)`);
      return tx.execute(sql`select 'ock' = any(show_trgm('lŭ')) as hashed, 'lock' <% 'lŭ' as hit,
        ${d.search.typoPrefilter("lock", { threshold: THRESHOLD, terms: sql`'lŭ'::text`, lowered: sql`lower('lŭ')` })!} as pass`);
    })) as unknown as Array<{ hashed: boolean; hit: boolean; pass: boolean }>;
    expect(row).toEqual({ hashed: true, hit: true, pass: true });
  });
});
