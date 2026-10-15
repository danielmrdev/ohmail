import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, rules as rulesTbl } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "../src/adapters/drizzle-repo.js";
import { compareRules, evaluateRules, type Rule } from "../src/rules.js";
import type { NormalizedMessage } from "../src/types.js";

/**
 * THE RULE ORDER, AGAINST REAL POSTGRES — a review finding, and the half PGlite cannot show.
 *
 * ── WHAT THE FINDING ACTUALLY WAS ──────────────────────────────────────────────────────────
 *
 * Reported as "equal-priority ties fall back to the caller's array position". The architect's
 * reading was worse: `drizzle-repo.ts#listRules` had **no `ORDER BY`**, so that array position was
 * PostgreSQL's PHYSICAL ROW ORDER. Physical order moves under UPDATE (a new tuple version lands
 * at a later ctid) and under VACUUM FULL (the heap is rewritten). **The same message routed
 * differently on different days with no rule change.**
 *
 * PGlite is single-connection and returns stable insertion order, so every existing test in this
 * repository was blind to it — the same blindness that hid three production bugs already. Hence a
 * `*.pg.test.ts` on :5433, and hence the physical-reordering PROBE below: a test that asserted
 * invariance without first proving the physical order really moved would be green by construction.
 *
 * ── THE FOUR COMBINATIONS THE RULING ASKS FOR ──────────────────────────────────────────────
 *
 * Tied rules created in BOTH insertion orders × {after an UPDATE, after `VACUUM FULL`}. In all
 * four, the user's sender-specific DENY must win over the broad domain ALLOW.
 *
 * ── AND THE DRIFT GUARD ────────────────────────────────────────────────────────────────────
 *
 * The `ORDER BY` mirrors `compareRules` in SQL so an operator can see the winner in `psql`. Two
 * expressions of one order is two things that can disagree, so the test sorts the adapter's output
 * with the exported comparator and requires that nothing moves.
 */

const AVAILABLE = await realPgAvailable();

function msg(from: string): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "x" },
    subject: "s", from: { name: null, address: from }, to: [],
    date: null, headers: { "list-unsubscribe": ["<mailto:u@vendor.example>"] },
    textBody: "", htmlBody: null, hasAttachments: false, attachments: [],
  };
}

/** The tied set, in ONE canonical listing. Every row is `priority = 0` — the default. */
interface Seed {
  label: string; kind: string; match: string; destination: string; provenance: string;
  /**
   * A NUDGED id, for the two rows whose only difference is provenance.
   *
   * `id` is the last clause of the order, so leaving those two on random UUIDs makes the
   * provenance guard a coin flip: half the time the random ids happen to fall in the same
   * order the provenance rank wants, and a broken rank passes. Measured — reverting the SQL
   * `case` arm to its old shared `else` and re-running went GREEN. Forcing ASCENDING ID ORDER
   * TO BE THE OPPOSITE of the provenance order makes the two statements of that order disagree
   * whenever they actually differ.
   *
   * Only the first hex digit is fixed; the rest stays random, because `rules.id` is a global
   * primary key and this file seeds the same set twice, into two accounts.
   */
  id?: "low" | "high";
}

/** A valid v4 UUID whose FIRST BYTE is forced, so two of them have a known relative order. */
function nudgedId(end: "low" | "high"): string {
  return (end === "low" ? "0" : "f") + randomUUID().slice(1);
}

const TIED: readonly Seed[] = [
  { label: "domain-allow", kind: "domain", match: "vendor.example", destination: "INBOX", provenance: "manual" },
  { label: "sender-deny", kind: "sender", match: "bad@vendor.example", destination: "ohmail/Screened", provenance: "manual" },
  { label: "header-allow", kind: "header", match: "list-unsubscribe", destination: "ohmail/News", provenance: "manual" },
  { label: "domain-deny", kind: "domain", match: "vendor.example", destination: "ohmail/Screener", provenance: "promoted" },
  // Two rows identical in EVERY semantic clause, so the `id` tie-break is the only thing that can
  // order them — which is what makes the SQL/TypeScript drift guard below non-vacuous.
  { label: "twin-a", kind: "sender", match: "ok@vendor.example", destination: "ohmail/News", provenance: "manual" },
  { label: "twin-b", kind: "sender", match: "ok@vendor.example", destination: "ohmail/News", provenance: "manual" },
  // PROVENANCE IS THE ONLY THING SEPARATING THESE TWO. Every other clause of the order —
  // priority, allow/deny, kind, match — is identical, so `expectSqlAgreesWithComparator` below
  // is comparing the two statements of the provenance rank and nothing else. Without this pair
  // a value left to fall into the SQL `case` expression's `else` arm ranks differently in
  // Postgres than in `compareRules` and no test anywhere notices.
  { label: "screened-in", kind: "sender", match: "dup@vendor.example", destination: "ohmail/News", provenance: "promoted", id: "high" },
  { label: "seeded", kind: "sender", match: "dup@vendor.example", destination: "ohmail/News", provenance: "seeded-from-sent", id: "low" },
];

describe.skipIf(!AVAILABLE)("listRules is deterministic against real Postgres", () => {
  let owned: OwnedDb;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // An INDEPENDENT pool: `makeDb`/`closeDb` share one module global, and this file must not be
    // able to close a handle another test owns (see `client.ts#makeOwnedDb`).
    owned = makeOwnedDb(PG_TEST_URL);
  }, 120_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  /** Seed the tied set in a given order and return the account plus the ids, in insertion order. */
  async function seed(order: readonly Seed[]): Promise<{ accountId: string; ids: string[] }> {
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `x1g5-${accountId.slice(0, 8)}` });
    const ids: string[] = [];
    for (const s of order) {
      // One INSERT per row, in sequence — a single multi-row INSERT would give the planner no
      // reason to lay them out in this order and the "insertion order" premise would be a guess.
      const [row] = await owned.db.insert(rulesTbl).values({
        accountId, kind: s.kind, match: s.match, destination: s.destination,
        priority: 0, provenance: s.provenance, enabled: true,
        ...(s.id ? { id: nudgedId(s.id) } : {}),
      }).returning({ id: rulesTbl.id });
      ids.push(row!.id);
    }
    return { accountId, ids };
  }

  /** The heap order — what `listRules` returned with no `ORDER BY` — sorted by ctid, whatever plan the
   *  select takes. */
  async function physicalOrder(accountId: string): Promise<HeapRow[]> {
    const rows = await owned.db.execute<HeapRow>(
      sql`select id, ctid::text as ctid from rules where account_id = ${accountId}::uuid`,
    );
    const at = (c: string) => c.slice(1, -1).split(",").map(Number);
    return [...rows].map((r) => ({ id: r.id, ctid: r.ctid }))
      .sort((a, b) => at(a.ctid)[0]! - at(b.ctid)[0]! || at(a.ctid)[1]! - at(b.ctid)[1]!);
  }
  type HeapRow = { id: string; ctid: string };
  const heapIds = (h: HeapRow[]) => h.map((r) => r.id).join();
  const ctids = (h: HeapRow[]) => h.map((r) => r.ctid).join(" ");
  /** Rewrites before the case gives up on a reorder — `rules-subject.pg.test.ts` measured the bound. */
  const PERTURBATIONS = 24;

  async function winner(accountId: string): Promise<{ rules: Rule[]; matchedRuleId: string | null }> {
    const rules = await makeDrizzleRepo(owned.db).listRules(accountId);
    const d = evaluateRules({
      msg: msg("bad@vendor.example"), rules, ownAddresses: new Set<string>(), knownSenders: { addresses: new Set(), inferred: new Set<string>(), lists: new Map() }, auth: "unauthenticated",
      ohboxPolicy: "people_and_replied", identity: null,
    });
    return { rules, matchedRuleId: d.matchedRuleId };
  }

  /** The adapter's `ORDER BY` and `compareRules` are two statements of one order. Pin them equal. */
  function expectSqlAgreesWithComparator(rules: Rule[]): void {
    const resorted = [...rules].sort(compareRules);
    expect(rules.map((r) => r.id)).toEqual(resorted.map((r) => r.id));
  }

  for (const [label, order] of [
    ["insertion order as listed", TIED],
    ["the reverse insertion order", [...TIED].reverse()],
  ] as const) {
    it(`a sender DENY beats a broad domain ALLOW — ${label}, before and after a physical reorder`, async (ctx) => {
      const { accountId, ids } = await seed(order);
      const denyId = ids[order.findIndex((s) => s.label === "sender-deny")]!;

      const before = await physicalOrder(accountId);
      expect(before).toHaveLength(TIED.length);

      const first = await winner(accountId);
      expect(first.matchedRuleId).toBe(denyId);
      expectSqlAgreesWithComparator(first.rules);

      // ── PERTURBATION 1: rewrite the physically-first row until the heap order moves. A new version
      // stays on its own page at the lowest free line pointer, so one UPDATE can land back in order
      // (a pointer freed below the next row, or a heap split across pages): an UPDATE and a move
      // (delete-and-reinsert) in turn, with the verdict and the comparator asserted at EVERY reading.
      const readings = [before];
      for (let i = 0; i < PERTURBATIONS && heapIds(readings.at(-1)!) === heapIds(before); i++) {
        const head = readings.at(-1)![0]!.id;
        if (i % 2 === 0) {
          await owned.db.update(rulesTbl).set({ priority: 0, updatedAt: new Date() }).where(eq(rulesTbl.id, head));
        } else {
          await owned.db.execute(sql`
            with gone as (delete from rules where id = ${head}::uuid returning *) insert into rules select * from gone`);
        }
        readings.push(await physicalOrder(accountId));
        const updated = await winner(accountId);
        expect(updated.matchedRuleId).toBe(denyId);
        expectSqlAgreesWithComparator(updated.rules);
      }

      // ── PERTURBATION 2: VACUUM FULL. Rewrites the whole heap. Cannot run inside a
      // transaction, so it goes out as its own statement.
      await owned.db.execute(sql.raw("vacuum full messages, rules"));
      readings.push(await physicalOrder(accountId));

      const vacuumed = await winner(accountId);
      expect(vacuumed.matchedRuleId).toBe(denyId);
      expectSqlAgreesWithComparator(vacuumed.rules);

      // ── THE PROBE THAT KEEPS THE ASSERTIONS ABOVE FROM BEING VACUOUS. A heap that never moved leaves
      // this run nothing to say about invariance, so it says so by name and skips rather than passing.
      if (readings.every((h) => heapIds(h) === heapIds(before))) {
        console.warn(`SKIPPED BY NAME: Postgres kept the heap order through ${PERTURBATIONS} rewrites and a `
          + `VACUUM FULL, so this run cannot test invariance under a reorder. heap=${ctids(before)}`);
        ctx.skip();
      }
      // …and some physical reading must disagree with the ordered read, or the `ORDER BY` is decoration.
      const ordered = vacuumed.rules.map((r) => r.id).join();
      expect(readings.some((h) => heapIds(h) !== ordered), `every heap reading WAS the ordered answer: ${ordered}`)
        .toBe(true);
    }, 120_000);
  }

  /**
   * The `id` clause, isolated. `twin-a` and `twin-b` are identical in priority, effect, kind and
   * provenance, so nothing but the id can separate them — and Postgres `uuid` ordering and
   * JavaScript string ordering of the canonical text form must agree, or the `ORDER BY` and
   * `compareRules` disagree on every real account with a promoted-rule pair.
   */
  it("the uuid tie-break means the same thing in SQL and in TypeScript", async () => {
    const { accountId } = await seed(TIED);
    const rules = await makeDrizzleRepo(owned.db).listRules(accountId);
    const twins = rules.filter((r) => r.match === "ok@vendor.example");
    expect(twins).toHaveLength(2);
    expect(twins[0]!.id < twins[1]!.id).toBe(true);
    expectSqlAgreesWithComparator(rules);
  }, 120_000);

  /**
   * `effectForDestination` is applied in the adapter, so the field the comparator reads has to
   * arrive with the row rather than be reconstructed by every consumer.
   */
  it("listRules stamps `effect` from the destination on every row", async () => {
    const { accountId } = await seed(TIED);
    const rules = await makeDrizzleRepo(owned.db).listRules(accountId);
    for (const r of rules) {
      const expected = ["ohmail/Screener", "ohmail/Screened", "ohmail/Quarantine"]
        .includes(r.destination) ? "deny" : "allow";
      expect(r.effect, `${r.destination} → ${r.effect}`).toBe(expected);
    }
  }, 120_000);
});
