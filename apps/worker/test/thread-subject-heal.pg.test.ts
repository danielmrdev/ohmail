import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq, inArray } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, changeLog, threads, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runThreadSubjectHeal } from "../src/thread-subject-heal.js";

/**
 * THE THREAD-NAME HEAL, AGAINST REAL POSTGRES.
 *
 * Real Postgres rather than PGlite for two load-bearing reasons: the candidate scan is a
 * `~*` ARE predicate built from the SAME string the JS regex is compiled from
 * (`SUBJECT_PREFIX_PATTERN`), and this file is what proves Postgres actually parses that
 * anatomy — `(?:…)`, `\s`, `\d`, the fullwidth-colon bracket expression — the way the JS
 * engine does; and every healed row allocates a seq under the account's counter row lock,
 * which is the transactional shape PGlite is structurally unable to contradict.
 *
 * The seeded names are the SHAPE production had: threads created from localized forwards
 * before `baseSubject` knew the forward prefixes, sitting beside reply-created threads whose
 * names were stripped correctly on day one.
 */

const AVAILABLE = await realPgAvailable();

describe.skipIf(!AVAILABLE)("thread-name heal", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 120_000);

  async function seedAccount(): Promise<string> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `heal-${accountId.slice(0, 8)}` });
    return accountId;
  }

  async function seedThread(accountId: string, subject: string): Promise<string> {
    const [t] = await db.insert(threads).values({
      accountId, subject, rootMessageIdHeader: `${randomUUID()}@example.test`,
    }).returning({ id: threads.id });
    return t!.id;
  }

  it("prefixed names converge, clean names and user renames are untouched, and mirrors are told", async () => {
    const accountId = await seedAccount();
    const healable = {
      wg: await seedThread(accountId, "WG: Webshop"),
      stacked: await seedThread(accountId, "AW: WG: Angebot"),
      antw: await seedThread(accountId, "Antw.: onderwerp"),
    };
    const untouched = {
      clean: await seedThread(accountId, "Webshop"),
      renamed: await seedThread(accountId, "What the user called it"),
      innocent: await seedThread(accountId, "Reserve: two seats"),
    };

    const r = await runThreadSubjectHeal({ db: db as unknown as Tx, apply: true });
    expect(r.healed).toBeGreaterThanOrEqual(3);
    expect(r.skipped).toBe(0);

    const rows = await db.select({ id: threads.id, subject: threads.subject }).from(threads)
      .where(eq(threads.accountId, accountId)).orderBy(asc(threads.id));
    const byId = new Map(rows.map((x) => [x.id, x.subject]));
    expect(byId.get(healable.wg)).toBe("Webshop");
    expect(byId.get(healable.stacked)).toBe("Angebot");
    expect(byId.get(healable.antw)).toBe("onderwerp");
    expect(byId.get(untouched.clean)).toBe("Webshop");
    expect(byId.get(untouched.renamed)).toBe("What the user called it");
    // "Reserve:" begins with a strippable token's letters and must survive — the SQL
    // pre-filter and the JS regex have to agree it is not a prefix.
    expect(byId.get(untouched.innocent)).toBe("Reserve: two seats");

    // Every healed row told the mirrors, exactly once, and nothing else did.
    const deltas = await db.select({ entityId: changeLog.entityId, op: changeLog.op }).from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "thread")));
    expect(deltas.map((d) => d.op)).toEqual(["update", "update", "update"]);
    expect(new Set(deltas.map((d) => d.entityId))).toEqual(new Set(Object.values(healable)));
  });

  it("is idempotent: the second run scans nothing, writes nothing, and appends no deltas", async () => {
    const accountId = await seedAccount();
    await seedThread(accountId, "WG: WG: Doppelt");

    const first = await runThreadSubjectHeal({ db: db as unknown as Tx, apply: true });
    expect(first.healed).toBeGreaterThanOrEqual(1);
    const deltasAfterFirst = (await db.select({ id: changeLog.seq }).from(changeLog)
      .where(eq(changeLog.accountId, accountId))).length;

    const second = await runThreadSubjectHeal({ db: db as unknown as Tx, apply: true });
    expect(second.healed).toBe(0);
    expect(second.skipped).toBe(0);
    const deltasAfterSecond = (await db.select({ id: changeLog.seq }).from(changeLog)
      .where(eq(changeLog.accountId, accountId))).length;
    expect(deltasAfterSecond).toBe(deltasAfterFirst);
  });

  it("dry run reports what it WOULD do and writes nothing at all", async () => {
    const accountId = await seedAccount();
    const id = await seedThread(accountId, "WG: Vorschau");

    const r = await runThreadSubjectHeal({ db: db as unknown as Tx, apply: false });
    expect(r.healed).toBeGreaterThanOrEqual(1);

    const [row] = await db.select({ subject: threads.subject }).from(threads).where(eq(threads.id, id));
    expect(row!.subject).toBe("WG: Vorschau");
    const deltas = await db.select({ id: changeLog.seq }).from(changeLog)
      .where(eq(changeLog.accountId, accountId));
    expect(deltas.length).toBe(0);
  });

  it("walks pages by cursor, so a dry run over more rows than one batch still terminates", async () => {
    const accountId = await seedAccount();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seedThread(accountId, `WG: Seite ${i}`));

    // batch=2 forces three pages; the predicate never empties in a dry run, so only the
    // cursor can end the walk. A hang here is the regression this test exists for.
    const r = await runThreadSubjectHeal({ db: db as unknown as Tx, apply: false, batch: 2 });
    expect(r.healed).toBeGreaterThanOrEqual(5);

    const rows = await db.select({ subject: threads.subject }).from(threads)
      .where(and(eq(threads.accountId, accountId), inArray(threads.id, ids)));
    for (const row of rows) expect(row.subject.startsWith("WG:")).toBe(true);
  });

  /**
   * MUTATION LOG — each observed against this file, then restored.
   *
   * 1. Change-log emission removed (the `recordChanges` call deleted): the first test failed
   *    with `expected [] to deeply equal [ 'update', 'update', 'update' ]` — a heal that
   *    renames silently is invisible to every mirror until re-bootstrap.
   * 2. The value guard dropped from the UPDATE (`where id only`): no test here can see it —
   *    single-writer by construction — which is exactly why the guard is also WRITTEN as the
   *    concurrent-rename contract in `thread-subject-heal.ts` and `skipped` is in the result
   *    shape. Kept honest by review, not by this suite.
   */
});
