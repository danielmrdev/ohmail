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
 * `rules.body_contains` AGAINST REAL POSTGRES — mail 0052.
 *
 * `rules-subject.pg.test.ts` names the four things a unit-green cannot prove, and each applies
 * here unchanged: the column exists and round-trips, the CHECK is real, the `ORDER BY` and
 * `compareRules` agree now that both have gained ANOTHER clause, and the order survives a
 * physical reorder. Two things are new:
 *
 *  · the THREE-WAY order — subject-only over body-only, both-terms over subject-only — is stated
 *    in SQL as well as in the comparator, and the ids are nudged so the id tie-break wants the
 *    exact opposite of every clause under test;
 *  · the 0050 and 0051 CHECKs are pinned EQUAL up to the column name, because 0051's file
 *    inherits 0050's measured predicate verbatim rather than re-deriving it, and the day the two
 *    definitions drift apart is the day one column's "blank" stops meaning the other's.
 */

const AVAILABLE = await realPgAvailable();

const SENDER = "info@sichersatt.example";
const TOKEN = "[NinjaFirewall]";

function msg(from: string, textBody: string): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "x" },
    subject: "Notification", from: { name: null, address: from }, to: [], cc: [],
    date: null, headers: {}, textBody, htmlBody: null, hasAttachments: false, attachments: [],
  };
}

/** A valid v4 UUID whose FIRST hex digit is forced, so a set of them has a known relative order. */
function nudgedId(first: "0" | "8" | "f"): string {
  return first + randomUUID().slice(1);
}

describe.skipIf(!AVAILABLE)("rules.body_contains against real Postgres", () => {
  let owned: OwnedDb;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 120_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  /**
   * The pair the feature is for. The NARROW (body-term) rule gets the HIGH id and the BROAD rule
   * the LOW one, so `asc(id)` — the last clause in both statements of the order — puts the broad
   * rule first unless the body clause reverses it.
   */
  async function seedPair(
    order: "narrow-first" | "broad-first" = "narrow-first",
  ): Promise<{ accountId: string; narrowId: string; broadId: string }> {
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `sB-${accountId.slice(0, 8)}` });
    const narrowId = nudgedId("f");
    const broadId = nudgedId("0");
    const narrow = () => owned.db.insert(rulesTbl).values({
      id: narrowId, accountId, kind: "sender", match: SENDER,
      destination: "ohmail/News", priority: 0, provenance: "manual", enabled: true,
      bodyContains: TOKEN,
    });
    const broad = () => owned.db.insert(rulesTbl).values({
      id: broadId, accountId, kind: "sender", match: SENDER,
      destination: "INBOX", priority: 0, provenance: "manual", enabled: true,
    });
    if (order === "narrow-first") { await narrow(); await broad(); } else { await broad(); await narrow(); }
    return { accountId, narrowId, broadId };
  }

  const listOf = (accountId: string): Promise<Rule[]> =>
    makeDrizzleRepo(owned.db).listRules(accountId);

  const route = (rules: Rule[], textBody: string) => evaluateRules({
    msg: msg(SENDER, textBody), rules, ownAddresses: new Set<string>(), knownSenders: { addresses: new Set([SENDER]), inferred: new Set<string>(), lists: new Map() },
    auth: "unauthenticated", ohboxPolicy: "people_and_replied", identity: null,
  });

  /** The adapter's `ORDER BY` and `compareRules` are two statements of one order. Pin them equal. */
  function expectSqlAgreesWithComparator(rules: Rule[]): void {
    const resorted = [...rules].sort(compareRules);
    expect(rules.map((r) => r.id)).toEqual(resorted.map((r) => r.id));
  }

  it("listRules carries the term back, verbatim, and NULL for a rule without one", async () => {
    const { accountId, narrowId, broadId } = await seedPair();
    const rules = await listOf(accountId);
    const byId = new Map(rules.map((r) => [r.id, r]));
    expect(byId.get(narrowId)!.bodyContains).toBe(TOKEN);
    expect(byId.get(broadId)!.bodyContains).toBeNull();
  });

  it("files the mail whose text carries the term and leaves the sender's other mail alone", async () => {
    // The whole feature end to end through the real adapter, BOTH directions from one rule set.
    const { accountId, narrowId, broadId } = await seedPair();
    const rules = await listOf(accountId);

    const alert = route(rules, `${TOKEN} brute-force attempt blocked`);
    expect(alert).toEqual({
      destination: "ohmail/News", matchedRuleId: narrowId, source: "rule",
    });

    const invoice = route(rules, "Rechnung 2026-08. Zahlbar in 30 Tagen.");
    expect(invoice).toEqual({ destination: "INBOX", matchedRuleId: broadId, source: "rule" });
  });

  it.each(["narrow-first", "broad-first"] as const)(
    "the ORDER BY puts the body rule first and agrees with compareRules — inserted %s",
    async (order) => {
      const { accountId, narrowId, broadId } = await seedPair(order);
      const rules = await listOf(accountId);
      expect(broadId < narrowId).toBe(true);
      expect(rules.map((r) => r.id)).toEqual([narrowId, broadId]);
      expectSqlAgreesWithComparator(rules);
      expect(route(rules, `${TOKEN} x`).matchedRuleId).toBe(narrowId);
      expect(route(rules, "Rechnung").matchedRuleId).toBe(broadId);
    },
    120_000,
  );

  it("orders subject-only over body-only over bare, and both-terms over all — in SQL too", async () => {
    // THE THREE-WAY DIRECTION. Ids nudged so ascending id order is the exact REVERSE of what the
    // clauses want: both-terms gets the highest id, bare the lowest. Only the two term clauses,
    // in their documented positions, can produce the asserted order — delete either SQL CASE (or
    // swap them) and this goes red deterministically.
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `sB3-${accountId.slice(0, 8)}` });
    const bareId = nudgedId("0");
    const bodyId = nudgedId("8");
    const subjectId = nudgedId("8");
    const bothId = nudgedId("f");
    const base = {
      accountId, kind: "sender", match: SENDER, destination: "ohmail/News",
      priority: 0, provenance: "manual", enabled: true,
    };
    await owned.db.insert(rulesTbl).values({ ...base, id: bareId, destination: "INBOX" });
    await owned.db.insert(rulesTbl).values({ ...base, id: bodyId, bodyContains: TOKEN });
    await owned.db.insert(rulesTbl).values({ ...base, id: subjectId, subjectContains: "Alert" });
    await owned.db.insert(rulesTbl).values({
      ...base, id: bothId, subjectContains: "Alert", bodyContains: TOKEN,
    });

    const rules = await listOf(accountId);
    expectSqlAgreesWithComparator(rules);
    // Positions, not raw id lists, because subjectId/bodyId share a nudge digit and their
    // relative UUID order is random — which is exactly why the term clauses must decide.
    const pos = new Map(rules.map((r, i) => [r.id, i]));
    expect(pos.get(bothId)).toBe(0);
    expect(pos.get(subjectId)).toBe(1);
    expect(pos.get(bodyId)).toBe(2);
    expect(pos.get(bareId)).toBe(3);
  }, 120_000);

  it("holds through an UPDATE — and the physical order really moved", async () => {
    // The UPDATE perturbation, not VACUUM FULL, for the reason `rules-subject.pg.test.ts`
    // measured: rewriting a large shared table for a two-row assertion takes an ACCESS
    // EXCLUSIVE lock that times out somebody else's suite.
    const { accountId, narrowId } = await seedPair();

    async function physicalOrder(): Promise<string[]> {
      await owned.db.execute(sql.raw("set enable_indexscan = off"));
      await owned.db.execute(sql.raw("set enable_bitmapscan = off"));
      await owned.db.execute(sql.raw("set enable_indexonlyscan = off"));
      try {
        const rows = await owned.db.execute<{ id: string }>(sql`
          select id from rules where account_id = ${accountId}::uuid`);
        return [...rows].map((r) => r.id);
      } finally {
        await owned.db.execute(sql.raw("reset enable_indexscan"));
        await owned.db.execute(sql.raw("reset enable_bitmapscan"));
        await owned.db.execute(sql.raw("reset enable_indexonlyscan"));
      }
    }

    const before = await physicalOrder();
    expect(before).toHaveLength(2);
    expect((await listOf(accountId)).map((r) => r.id)[0]).toBe(narrowId);

    await owned.db.update(rulesTbl).set({ updatedAt: new Date() })
      .where(eq(rulesTbl.id, before[0]!));
    const afterUpdate = await physicalOrder();

    const ordered = await listOf(accountId);
    expect(ordered.map((r) => r.id)[0]).toBe(narrowId);
    expectSqlAgreesWithComparator(ordered);

    // The anti-vacuity probe: if the heap never moved, invariance was asserted against an input
    // that never varied.
    expect(
      before.join() !== afterUpdate.join(),
      "the UPDATE did not change the physical row order, so this test asserted invariance " +
        `against an input that never varied. before=${before.join()} afterUpdate=${afterUpdate.join()}`,
    ).toBe(true);
    expect(ordered.map((r) => r.id)).not.toEqual(afterUpdate);
  }, 120_000);

  // ── ORDER IS LOAD-BEARING FROM HERE DOWN, and it was measured, not reasoned to. ──────────
  // The whitespace-ranks-as-bare test below DROPS the constraint and its `finally` RE-ADDS it
  // from a literal in this file. Run before the two constraint tests, that re-add silently
  // REPAIRS a broken migration before anything measures it: this file was watched staying green
  // with the live CHECK mutated to the one-argument-`btrim` form, because the re-add had already
  // replaced the mutant. So the tests that measure the constraint AS THE DATABASE HAS IT come
  // first, and the test that reconstructs it comes last.

  it("the CHECK refuses an empty and a whitespace-only term, and anything over 200 chars", async () => {
    // FIRST: the constraint is actually on the table — without this, its absence would satisfy
    // every rejection below and the message would blame the CHECK for not existing.
    const [con] = await owned.db.execute<{ n: string }>(sql`
      select conname as n from pg_constraint c
        join pg_class t on t.oid = c.conrelid
       where t.relname = 'rules' and c.contype = 'c'
         and c.conname = 'rules_body_contains_nonempty'`);
    expect(con, "rules_body_contains_nonempty is not on the table at all").toBeDefined();

    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `sBc-${accountId.slice(0, 8)}` });
    const base = {
      accountId, kind: "sender", match: SENDER, destination: "ohmail/News",
      priority: 0, provenance: "manual", enabled: true,
    };
    // `"\t"` is on this list because it is the shape one-argument `btrim` lets through — the 0050
    // measurement, inherited. Each insert is its own failed statement.
    for (const term of ["", "   ", "\t", "\n", "\v", " \t\n ", "x".repeat(201)]) {
      await expect(
        owned.db.insert(rulesTbl).values({ ...base, id: randomUUID(), bodyContains: term }),
        `rules_body_contains_nonempty accepted ${JSON.stringify(term.slice(0, 12))}`,
      ).rejects.toThrow();
    }
    // The boundary is inclusive on the legal side…
    await owned.db.insert(rulesTbl).values({
      ...base, id: randomUUID(), bodyContains: "x".repeat(200),
    });
    // …and padding around legal content is legal: the predicate is content, not tidiness.
    await owned.db.insert(rulesTbl).values({
      ...base, id: randomUUID(), bodyContains: ` ${TOKEN} `,
    });
  });

  it("the 0050 and 0051 CHECKs are the same predicate up to the column name", async () => {
    // 0051 inherits 0050's measured regex VERBATIM — this is the guard that keeps "inherits"
    // true. The two definitions are read back from the catalog and compared after mapping the
    // column name, so any drift — a re-derived `btrim`, a different class, a different ceiling —
    // goes red here whichever file it lands in.
    const rows = await owned.db.execute<{ n: string; def: string }>(sql`
      select conname as n, pg_get_constraintdef(c.oid) as def
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
       where t.relname = 'rules' and c.contype = 'c'
         and c.conname in ('rules_subject_contains_nonempty', 'rules_body_contains_nonempty')`);
    const byName = new Map([...rows].map((r) => [r.n, r.def]));
    const subjectDef = byName.get("rules_subject_contains_nonempty");
    const bodyDef = byName.get("rules_body_contains_nonempty");
    expect(subjectDef, "the 0050 CHECK is missing").toBeDefined();
    expect(bodyDef, "the 0051 CHECK is missing").toBeDefined();
    expect(bodyDef!.replaceAll("body_contains", "subject_contains")).toBe(subjectDef!);
  });

  it("a whitespace-only term ranks and matches as BARE in SQL and in TypeScript alike", async () => {
    // The row shape a producer the constraint never reached would write. Both readers must
    // classify it as absent, or the blank rule wins its tie in SQL and then declines to fire.
    // The constraint comes off for the length of this test; the `finally` DELETES the offending
    // row FIRST (re-adding over a live violation fails and leaves the table unconstrained for
    // every later test — measured by the subject file's first run). LAST in this file — see the
    // order note above: its re-add must never run before the constraint measurements.
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `sBb-${accountId.slice(0, 8)}` });
    const blankId = nudgedId("f");
    const bareId = nudgedId("0");

    await owned.db.execute(sql`
      alter table rules drop constraint if exists rules_body_contains_nonempty`);
    try {
      await owned.db.insert(rulesTbl).values({
        id: blankId, accountId, kind: "sender", match: SENDER,
        destination: "ohmail/News", priority: 0, provenance: "manual", enabled: true,
        bodyContains: "   ",
      });
      await owned.db.insert(rulesTbl).values({
        id: bareId, accountId, kind: "sender", match: SENDER,
        destination: "INBOX", priority: 0, provenance: "manual", enabled: true,
      });

      const rules = await listOf(accountId);
      expect(rules.map((r) => r.id)).toEqual([bareId, blankId]);
      expectSqlAgreesWithComparator(rules);
      expect(route(rules, "anything at all").matchedRuleId).toBe(bareId);
    } finally {
      await owned.db.delete(rulesTbl).where(eq(rulesTbl.accountId, accountId));
      await owned.db.execute(sql`
        alter table rules add constraint rules_body_contains_nonempty
        check (body_contains is null
               or (body_contains ~ '[^ \\t\\n\\r\\f\\v]' and length(body_contains) <= 200))`);
    }
  });

});
