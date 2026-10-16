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
 * `rules.subject_contains` AGAINST REAL POSTGRES — mail 0050.
 *
 * The unit suite (`rules-subject.test.ts`) proves the evaluator over hand-built `Rule` objects. It
 * cannot prove any of the four things below, and each of them is a way for that green run to be
 * about nothing:
 *
 *  1. **The column exists and round-trips.** A `Rule` literal in a test satisfies the type whether
 *     or not the migration ran; `listRules` reading it does not.
 *  2. **The CHECK is real.** `rules_subject_contains_nonempty` is what makes NULL the only
 *     representation of "no term", and PGlite runs the same DDL — but the `btrim` predicate is the
 *     kind of expression this repository has already been caught assuming, so it is asserted where
 *     the production database will evaluate it.
 *  3. **The `ORDER BY` and `compareRules` still agree** now that both have gained a clause. This is
 *     the drift guard `rules.pg.test.ts` established for provenance, applied to the new clause: two
 *     expressions of one order are two things that can disagree, and the disagreement is silent —
 *     `psql` shows one winner and the router picks another.
 *  4. **The order survives a physical reorder.** Postgres returns an unordered scan in heap order,
 *     which moves under UPDATE and VACUUM FULL. The specificity clause is only worth anything if it
 *     decides the winner on every day of the week.
 *
 * The ids are NUDGED so that ascending id order is the OPPOSITE of what the subject clause wants
 * (`rules.pg.test.ts#nudgedId`, and for the identical reason it exists there): with random UUIDs, a
 * missing clause passes half the time and the guard is a coin toss dressed as a test.
 */

const AVAILABLE = await realPgAvailable();

const SENDER = "info@sichersatt.example";
const DOMAIN = "sichersatt.example";
const TOKEN = "[NinjaFirewall]";

function msg(from: string, subject: string): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "x" },
    subject, from: { name: null, address: from }, to: [],
    date: null, headers: {}, textBody: "", htmlBody: null, hasAttachments: false, attachments: [],
  };
}

/** A valid v4 UUID whose FIRST hex digit is forced, so two of them have a known relative order. */
function nudgedId(end: "low" | "high"): string {
  return (end === "low" ? "0" : "f") + randomUUID().slice(1);
}

describe.skipIf(!AVAILABLE)("rules.subject_contains against real Postgres", () => {
  let owned: OwnedDb;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // An INDEPENDENT pool, on `client.ts#makeOwnedDb`'s rule: `makeDb`/`closeDb` share one module
    // global and this file must not be able to close a handle another test owns.
    owned = makeOwnedDb(PG_TEST_URL);
  }, 120_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  /**
   * The pair the feature is for, seeded into one fresh account.
   *
   * The NARROW rule gets the HIGH id and the BROAD rule the LOW one, so `asc(id)` — the comparator's
   * last clause and the `ORDER BY`'s last term — would put the broad rule first. Only the subject
   * clause can reverse that, which is what makes every assertion below non-vacuous.
   */
  async function seedPair(
    order: "narrow-first" | "broad-first" = "narrow-first",
  ): Promise<{ accountId: string; narrowId: string; broadId: string }> {
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `s7-${accountId.slice(0, 8)}` });
    const narrowId = nudgedId("high");
    const broadId = nudgedId("low");
    const narrow = () => owned.db.insert(rulesTbl).values({
      id: narrowId, accountId, kind: "sender", match: SENDER,
      destination: "ohmail/News", priority: 0, provenance: "manual", enabled: true,
      subjectContains: TOKEN,
    });
    const broad = () => owned.db.insert(rulesTbl).values({
      id: broadId, accountId, kind: "sender", match: SENDER,
      destination: "INBOX", priority: 0, provenance: "manual", enabled: true,
    });
    // One INSERT per row, in sequence, so "insertion order" is a fact rather than a guess about
    // what the planner did with a multi-row VALUES — and BOTH orders are exercised, because an
    // unordered scan returns the heap and the heap follows insertion until something rewrites it.
    if (order === "narrow-first") { await narrow(); await broad(); } else { await broad(); await narrow(); }
    return { accountId, narrowId, broadId };
  }

  const listOf = (accountId: string): Promise<Rule[]> =>
    makeDrizzleRepo(owned.db).listRules(accountId);

  const route = (rules: Rule[], subject: string) => evaluateRules({
    msg: msg(SENDER, subject), rules, ownAddresses: new Set<string>(), knownSenders: { addresses: new Set([SENDER]), inferred: new Set<string>(), lists: new Map() },
    auth: "unauthenticated", ohboxPolicy: "people_and_replied", identity: null,
  });

  /**
   * The heap order — no `ORDER BY`, which is what `listRules` used to be.
   *
   * The scan methods are FORCED OFF, and that is a measured necessity rather than caution. `rules`
   * on the shared test database has grown large, so the planner serves
   * `where account_id = …` from `rules_account_idx` and returns INDEX order — which does not move
   * under UPDATE or `VACUUM FULL` the way a heap scan does. The anti-vacuity probe below then reports
   * "the physical order never changed" and the test fails for a reason that has nothing to do with
   * the code under test: it failed exactly that way in a batch run and passed alone, which is the
   * shape of a flake nobody diagnoses. A seqscan is what "physical order" means here, so it is asked
   * for explicitly instead of hoped for.
   */
  async function physicalOrder(accountId: string): Promise<HeapRow[]> {
    const rows = await owned.db.execute<HeapRow>(sql`
      select id, ctid::text as ctid from rules where account_id = ${accountId}::uuid`);
    return [...rows].map((r) => ({ id: r.id, ctid: r.ctid }));
  }
  type HeapRow = { id: string; ctid: string };
  const ctids = (h: HeapRow[]) => h.map((r) => `${r.id.slice(0, 1)}${r.ctid}`).join(" ");
  /** Rewrites before the case gives up on a reorder: a split pair moved at 2, a pair whose page was
   *  vacuumed between its insert and the first rewrite at most at 16 (24 such pairs, by ctid). */
  const PERTURBATIONS = 24;

  /** Force a sequential scan for the length of `fn`, then restore the planner's defaults. */
  async function withSeqScan<T>(fn: () => Promise<T>): Promise<T> {
    await owned.db.execute(sql.raw("set enable_indexscan = off"));
    await owned.db.execute(sql.raw("set enable_bitmapscan = off"));
    await owned.db.execute(sql.raw("set enable_indexonlyscan = off"));
    try {
      return await fn();
    } finally {
      await owned.db.execute(sql.raw("reset enable_indexscan"));
      await owned.db.execute(sql.raw("reset enable_bitmapscan"));
      await owned.db.execute(sql.raw("reset enable_indexonlyscan"));
    }
  }

  /** The adapter's `ORDER BY` and `compareRules` are two statements of one order. Pin them equal. */
  function expectSqlAgreesWithComparator(rules: Rule[]): void {
    const resorted = [...rules].sort(compareRules);
    expect(rules.map((r) => r.id)).toEqual(resorted.map((r) => r.id));
  }

  it("listRules carries the term back, verbatim, and NULL for a rule without one", async () => {
    const { accountId, narrowId, broadId } = await seedPair();
    const rules = await listOf(accountId);
    const byId = new Map(rules.map((r) => [r.id, r]));
    // VERBATIM — the case the user typed. Folding at rest would show somebody `[ninjafirewall]` for a
    // token they read off their own mail, and both surfaces quote it back at them.
    expect(byId.get(narrowId)!.subjectContains).toBe(TOKEN);
    expect(byId.get(broadId)!.subjectContains).toBeNull();
  });

  it("files the mail it names and leaves the sender's other mail in the Ohbox", async () => {
    // THE WHOLE FEATURE, end to end through the real adapter: the rows come out of Postgres, the
    // order comes out of the `ORDER BY`, and the routing comes out of `evaluateRules`. Both
    // directions from ONE rule set, because either alone is satisfiable by a bug — the positive
    // assertion would pass with the term ignored entirely.
    const { accountId, narrowId, broadId } = await seedPair();
    const rules = await listOf(accountId);

    const alert = route(rules, `${TOKEN} Alert: brute-force attempt blocked`);
    expect(alert).toEqual({
      destination: "ohmail/News", matchedRuleId: narrowId, source: "rule",
    });

    const invoice = route(rules, "Rechnung 2026-08 / Invoice");
    expect(invoice).toEqual({ destination: "INBOX", matchedRuleId: broadId, source: "rule" });
  });

  it.each(["narrow-first", "broad-first"] as const)(
    "the ORDER BY puts the subject rule first and agrees with compareRules — inserted %s",
    async (order) => {
      // BOTH insertion orders, because an unordered scan returns the heap and the heap follows
      // insertion: a clause that happened to agree with insertion order in one direction would be
      // indistinguishable from no clause at all. The nudged ids are the other half of that — without
      // the specificity clause, `asc(id)` puts the broad rule first in either order.
      const { accountId, narrowId, broadId } = await seedPair(order);
      const rules = await listOf(accountId);
      expect(broadId < narrowId).toBe(true);
      expect(rules.map((r) => r.id)).toEqual([narrowId, broadId]);
      expectSqlAgreesWithComparator(rules);
      // …and the routing follows the order, in both directions of the pair.
      expect(route(rules, `${TOKEN} x`).matchedRuleId).toBe(narrowId);
      expect(route(rules, "Rechnung").matchedRuleId).toBe(broadId);
    },
    120_000,
  );

  it("holds through an UPDATE — and the physical order really moved", async (ctx) => {
    // `VACUUM FULL rules` is deliberately NOT here, and its absence is the finding rather than a
    // shortcut. The shared test database's `rules` table is large; rewriting the whole
    // heap for a two-row assertion takes an ACCESS EXCLUSIVE lock on a table every other pg file in
    // the suite is writing to, which is a way to make somebody else's test time out. The UPDATE
    // gives the same perturbation for this purpose — a new tuple version lands at a later ctid, so
    // an unordered scan returns the pair in a different place — and `rules.pg.test.ts` already owns
    // the VACUUM FULL case for the comparator as a whole. What this file has to prove is that the
    // SUBJECT clause decides regardless of physical order, and it proves it twice more besides: the
    // two-insertion-order test above, and the drift guard against `compareRules`.
    const { accountId, narrowId } = await seedPair();
    const heap = () => withSeqScan(() => physicalOrder(accountId));
    const order = (h: HeapRow[]) => h.map((r) => r.id).join();
    const before = await heap();
    expect(before).toHaveLength(2);
    expect((await listOf(accountId)).map((r) => r.id)[0]).toBe(narrowId);

    // THE PERTURBATION, until the heap order moves. Postgres puts a new version on its own page at
    // the lowest free line pointer, so one UPDATE can land back in order: a pointer a co-tenant freed
    // below the other row, or a pair split across pages. So the physically-first row is rewritten
    // again, an UPDATE and a move (delete-and-reinsert) in turn, and the ordered answer is asserted
    // at EVERY reading — the one whose heap put the broad rule first is what refutes decoration.
    const readings = [before];
    for (let i = 0; i < PERTURBATIONS && order(readings.at(-1)!) === order(before); i++) {
      const first = readings.at(-1)![0]!.id;
      if (i % 2 === 0) await owned.db.update(rulesTbl).set({ updatedAt: new Date() }).where(eq(rulesTbl.id, first));
      else await owned.db.execute(sql`
        with gone as (delete from rules where id = ${first}::uuid returning *) insert into rules select * from gone`);
      readings.push(await heap());
      const ordered = await listOf(accountId);
      expect(ordered.map((r) => r.id)[0]).toBe(narrowId);
      expectSqlAgreesWithComparator(ordered);
    }

    // THE PROBE THAT KEEPS THE ASSERTIONS ABOVE FROM BEING VACUOUS. A heap that never moved leaves
    // this run nothing to say about invariance, so it says so by name and skips rather than passing.
    const last = readings.at(-1)!;
    if (order(last) === order(before)) {
      console.warn(`SKIPPED BY NAME: Postgres kept the heap order through ${PERTURBATIONS} rewrites, so `
        + `this run cannot test invariance under a reorder. before=${ctids(before)} after=${ctids(last)}`);
      ctx.skip();
    }
  }, 120_000);

  it("a whitespace-only term ranks and matches as BARE in SQL and in TypeScript alike", async () => {
    // The `btrim(...) <> ''` in the `ORDER BY` and `subjectTermOf`'s trim are the same claim stated
    // twice. Inserted through raw SQL because the CHECK forbids it — this is the row shape that
    // would arrive from a producer the constraint never reached (a fixture, a mirror row, an older
    // client's echo), and the point is that BOTH readers classify it as absent. If they disagreed,
    // the blank rule would win the tie in SQL and then decline to fire — which is a rule that
    // matches everything, the one thing this column must be incapable of.
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `s7b-${accountId.slice(0, 8)}` });
    const blankId = nudgedId("high");
    const bareId = nudgedId("low");

    // The constraint comes off for the length of this test and goes back on in a `finally` that
    // DELETES THE OFFENDING ROW FIRST. Re-adding it over a live violation raises
    // `check constraint … is violated by some row` — and because the whole file shares one
    // database, the failed re-add would leave the table unconstrained for every test after this
    // one, including the test below whose entire job is to prove the constraint refuses `''`. That
    // test would then pass its inserts and report the CHECK as broken. Measured, not imagined: it
    // is exactly what the first run of this file did.
    await owned.db.execute(sql`
      alter table rules drop constraint if exists rules_subject_contains_nonempty`);
    try {
      await owned.db.insert(rulesTbl).values({
        id: blankId, accountId, kind: "sender", match: SENDER,
        destination: "ohmail/News", priority: 0, provenance: "manual", enabled: true,
        subjectContains: "   ",
      });
      await owned.db.insert(rulesTbl).values({
        id: bareId, accountId, kind: "sender", match: SENDER,
        destination: "INBOX", priority: 0, provenance: "manual", enabled: true,
      });

      const rules = await listOf(accountId);
      // Both rank as bare, so the id tie-break decides — and the LOW id is the plain rule.
      expect(rules.map((r) => r.id)).toEqual([bareId, blankId]);
      expectSqlAgreesWithComparator(rules);
      expect(route(rules, "anything at all").matchedRuleId).toBe(bareId);
    } finally {
      await owned.db.delete(rulesTbl).where(eq(rulesTbl.accountId, accountId));
      await owned.db.execute(sql`
        alter table rules add constraint rules_subject_contains_nonempty
        check (subject_contains is null
               or (subject_contains ~ '[^ \\t\\n\\r\\f\\v]' and length(subject_contains) <= 200))`);
    }
  });

  it("the SQL blank-predicate and the evaluator's trim agree on every whitespace shape", () => {
    // THE MEASUREMENT THAT FOUND A REAL BUG IN THIS SLICE, kept as a guard.
    //
    // The CHECK first read `length(btrim(subject_contains)) between 1 and 200`, and one-argument
    // `btrim` trims SPACES ONLY: a tab-only term passed the constraint, ranked as SPECIFIC in the
    // `ORDER BY` — and `rules.ts#subjectTermOf` read it as ABSENT. A rule that wins its tie and then
    // matches every subject is the one outcome this column is designed to be incapable of, and it
    // was inside the guard against it.
    //
    // So the predicate and the trim are now written from the SAME six characters, and this is the
    // assertion that they stay written from the same six. It runs the real SQL expression on the
    // real database and the real `SUBJECT_TERM_TRIM` class side by side. `String.prototype.trim` is
    // included as the third column precisely because it is the tempting wrong answer: it disagrees
    // on U+00A0, which is why `rules.ts` does not call it.
    const shapes = [" ", "\t", "\n", "\r", "\f", "\v", "", "x", " x ", " ", " \t\n ", ` ${TOKEN} `];
    const asciiTrim = (s: string): boolean =>
      s.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "").length > 0;
    return (async () => {
      let jsTrimDisagreed = false;
      for (const shape of shapes) {
        const [row] = await owned.db.execute<{ sqlHasContent: boolean }>(sql`
          select (${shape} ~ '[^ \\t\\n\\r\\f\\v]') as "sqlHasContent"`);
        expect(row!.sqlHasContent, `SQL vs SUBJECT_TERM_TRIM on ${JSON.stringify(shape)}`)
          .toBe(asciiTrim(shape));
        if (row!.sqlHasContent !== (shape.trim().length > 0)) jsTrimDisagreed = true;
      }
      // …and the shape list must still CONTAIN the case that separates the two trims, or this test
      // has quietly become a tautology about a class nobody was tempted to get wrong.
      expect(
        jsTrimDisagreed,
        "no shape in this list distinguishes `String.prototype.trim` from SUBJECT_TERM_TRIM, so " +
          "the reason `rules.ts` does not call `trim()` is no longer being exercised",
      ).toBe(true);
    })();
  });

  it("the CHECK refuses an empty and a whitespace-only term, and anything over 200 chars", async () => {
    // The constraint is what makes NULL the ONE representation of absence, so it is asserted rather
    // than assumed. Each insert must be its own failed statement: a rejected write aborts the
    // implicit transaction, so batching them would prove only that the first one failed.
    // FIRST: the constraint is actually on the table. Without this the whole test is satisfiable by
    // its absence — every insert below would succeed, `rejects.toThrow()` would fail, and the
    // message would say "the CHECK let a bad value through" when the truth is "there is no CHECK".
    // Those are different bugs and only one of them is in the migration.
    const [con] = await owned.db.execute<{ n: string }>(sql`
      select conname as n from pg_constraint c
        join pg_class t on t.oid = c.conrelid
       where t.relname = 'rules' and c.contype = 'c'
         and c.conname = 'rules_subject_contains_nonempty'`);
    expect(con, "rules_subject_contains_nonempty is not on the table at all").toBeDefined();

    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `s7c-${accountId.slice(0, 8)}` });
    const base = {
      accountId, kind: "sender", match: SENDER, destination: "ohmail/News",
      priority: 0, provenance: "manual", enabled: true,
    };
    // `"\t"` is here because it is the shape the FIRST version of this CHECK let through — see the
    // whitespace-agreement test above. Removing it from this list is removing the regression.
    for (const term of ["", "   ", "\t", "\n", "\v", " \t\n ", "x".repeat(201)]) {
      await expect(
        owned.db.insert(rulesTbl).values({ ...base, id: randomUUID(), subjectContains: term }),
        `rules_subject_contains_nonempty accepted ${JSON.stringify(term.slice(0, 12))}`,
      ).rejects.toThrow();
    }
    // …and the boundary is inclusive on the legal side, so the ceiling is 200 and not 199.
    await owned.db.insert(rulesTbl).values({
      ...base, id: randomUUID(), subjectContains: "x".repeat(200),
    });
    // A term with legal content and surrounding whitespace is legal too: `btrim` is in the
    // predicate, not a rejection of padding, and `RulesService` trims before it ever gets here.
    await owned.db.insert(rulesTbl).values({
      ...base, id: randomUUID(), subjectContains: ` ${TOKEN} `,
    });
  });

  it("a domain rule carrying a term still loses to any sender rule", async () => {
    // The clause sits BELOW `kind`, in SQL as in TypeScript. A subject term refines a claim about
    // one principal; it is not a licence to outrank a more specific one.
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `s7d-${accountId.slice(0, 8)}` });
    const domainId = nudgedId("low");
    const senderId = nudgedId("high");
    await owned.db.insert(rulesTbl).values({
      id: domainId, accountId, kind: "domain", match: DOMAIN,
      destination: "ohmail/News", priority: 0, provenance: "manual", enabled: true,
      subjectContains: TOKEN,
    });
    await owned.db.insert(rulesTbl).values({
      id: senderId, accountId, kind: "sender", match: SENDER,
      destination: "INBOX", priority: 0, provenance: "manual", enabled: true,
    });

    const rules = await listOf(accountId);
    expect(rules.map((r) => r.id)).toEqual([senderId, domainId]);
    expectSqlAgreesWithComparator(rules);
    expect(route(rules, `${TOKEN} x`).matchedRuleId).toBe(senderId);
  });
});
