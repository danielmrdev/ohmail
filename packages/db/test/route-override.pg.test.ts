import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { schema, accounts, graduations, learningSignals, rules } from "../src/schema.js";
import {
  demoteRoute, recordRouteOverride, recordLearningSignal, routeOverrideActionId,
  OVERRIDE_DEMOTION_THRESHOLD, OVERRIDE_WINDOW_MS,
  type RouteOverrideOutcome, type Tx,
} from "../src/index.js";

/**
 * THE OVERRIDE PREDICATE ON REAL POSTGRES.
 *
 * On real Postgres and not PGlite because the whole predicate is a read: a window bound
 * compared against a `timestamptz` column, and three-column matching with two `IS NULL` arms.
 * PGlite accepts parameter shapes postgres-js refuses, and a route's demotion turning on a
 * comparison that only binds under one driver is exactly the class of defect that ships green.
 */

const AVAILABLE = await realPgAvailable();
const NOW = new Date("2026-09-11T12:00:00.000Z");
const SENDER = "roster@example.test";
const FILED_TO = "ohmail.Feed";
const MOVED_TO = "INBOX";

describe.skipIf(!AVAILABLE)("an override of a graduated route", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;
  let accountId: string;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  });

  /** A fresh account per case: every read here is account-scoped, so nothing leaks sideways. */
  beforeEach(async () => {
    accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: "override" });
  });

  const tx = (): Tx => db as unknown as Tx;

  async function graduate(patternKey: string): Promise<void> {
    await db.insert(graduations).values({
      accountId, patternKey, action: "route", positives: 3, negatives: 0, graduated: true,
      graduatedAt: new Date(NOW.getTime() - 90 * 24 * 3600_000),
    });
  }

  async function promotedRule(kind: "sender" | "domain", match: string): Promise<string> {
    const [row] = await db.insert(rules).values({
      accountId, kind, match, destination: FILED_TO, provenance: "promoted", enabled: true,
    }).returning({ id: rules.id });
    return row!.id;
  }

  /** The caller's whole shape: the override in its own commit, then the one door when it owes it. */
  async function settled(out: RouteOverrideOutcome | null): Promise<(RouteOverrideOutcome & { ruleIds: string[] }) | null> {
    if (out === null) return null;
    return { ...out, ruleIds: out.demoted ? (await demoteRoute(tx(), accountId, out.patternKey)).ruleIds : [] };
  }

  const override = async (messageId: string, seq: number | string) => settled(await recordRouteOverride(tx(), accountId, {
    senderAddress: SENDER, senderDomain: "example.test", filedTo: FILED_TO,
    triggeringActionId: routeOverrideActionId(messageId, String(seq)), now: NOW,
  }));

  it(`demotes the route at ${OVERRIDE_DEMOTION_THRESHOLD} overrides in the window, and not before`, async () => {
    await graduate(`sender:${SENDER}→${FILED_TO}`);
    const ruleId = await promotedRule("sender", SENDER);

    const first = await override(randomUUID(), 1);
    expect(first).toMatchObject({ overrides: 1, demoted: false, ruleIds: [] });
    // Still auto-applying: one contradiction is a person changing their mind about one message.
    expect(await graduatedNow()).toBe(true);

    const second = await override(randomUUID(), 2);
    expect(second).toMatchObject({ overrides: OVERRIDE_DEMOTION_THRESHOLD, demoted: true });
    expect(second!.ruleIds).toEqual([ruleId]);
    expect(await graduatedNow()).toBe(false);

    const [rule] = await db.select({ enabled: rules.enabled, demotions: rules.demotions })
      .from(rules).where(eq(rules.id, ruleId));
    expect(rule).toEqual({ enabled: false, demotions: 1 });
  });

  it("counts a replayed adoption once — the same move cannot demote twice", async () => {
    await graduate(`sender:${SENDER}→${FILED_TO}`);
    const ruleId = await promotedRule("sender", SENDER);
    const messageId = randomUUID();

    expect(await override(messageId, 7)).toMatchObject({ overrides: 1, demoted: false });
    // The SAME adoption, replayed: same message, same seq, so the same triggering-action id.
    expect(await override(messageId, 7)).toBeNull();
    expect(await graduatedNow()).toBe(true);

    const [rule] = await db.select({ enabled: rules.enabled }).from(rules).where(eq(rules.id, ruleId));
    expect(rule).toEqual({ enabled: true });
  });

  it("re-graduates on the person's confirmations — the overrides stay on the record", async () => {
    const patternKey = `sender:${SENDER}→${FILED_TO}`;
    await graduate(patternKey);
    await promotedRule("sender", SENDER);
    await override(randomUUID(), 1);
    await override(randomUUID(), 2);
    expect(await graduatedNow()).toBe(false);

    // Each override bumped `negatives`, so re-graduation costs one confirmation per override:
    // the counter is the same one graduation was earned on, and it does not forget.
    await confirm("a");
    expect(await graduatedNow()).toBe(false);
    await confirm("b");
    expect(await graduatedNow()).toBe(true);
  });

  it("ignores an override that has aged out of the window", async () => {
    await graduate(`sender:${SENDER}→${FILED_TO}`);
    await promotedRule("sender", SENDER);
    // One override a day older than the window. Written directly, because the insert stamps
    // `created_at` from the column default and the age is the thing under test.
    await db.insert(learningSignals).values({
      accountId, triggeringActionId: routeOverrideActionId(randomUUID(), "old"),
      kind: "external_move", senderAddress: SENDER, senderDomain: null, destination: FILED_TO,
      label: "negative",
      createdAt: new Date(NOW.getTime() - OVERRIDE_WINDOW_MS - 24 * 3600_000),
    });

    const out = await override(randomUUID(), 1);
    expect(out).toMatchObject({ overrides: 1, demoted: false });
    expect(await graduatedNow()).toBe(true);
  });

  it("counts only overrides of THIS route — another sender to the same folder is not evidence", async () => {
    await graduate(`sender:${SENDER}→${FILED_TO}`);
    await promotedRule("sender", SENDER);
    await recordLearningSignal(tx(), accountId, {
      triggeringActionId: routeOverrideActionId(randomUUID(), "other"),
      kind: "external_move", senderAddress: "someone.else@example.test", destination: FILED_TO,
      label: "negative",
    });

    const out = await override(randomUUID(), 1);
    expect(out).toMatchObject({ overrides: 1, demoted: false });
    expect(await graduatedNow()).toBe(true);
  });

  it("matches a DOMAIN route on the domain, and case does not change the answer", async () => {
    await graduate(`domain:example.test→${FILED_TO}`);
    const ruleId = await promotedRule("domain", "example.test");

    const shout = async (messageId: string, seq: string) => settled(await recordRouteOverride(tx(), accountId, {
      senderAddress: "ROSTER@EXAMPLE.TEST", senderDomain: "EXAMPLE.TEST", filedTo: FILED_TO,
      triggeringActionId: routeOverrideActionId(messageId, seq), now: NOW,
    }));

    const first = await shout(randomUUID(), "1");
    expect(first).toMatchObject({ patternKey: `domain:example.test→${FILED_TO}`, overrides: 1 });
    const second = await shout(randomUUID(), "2");
    expect(second).toMatchObject({ demoted: true, ruleIds: [ruleId] });
  });

  it("leaves an ordinary adoption alone — no graduated route filed it, nothing to contradict", async () => {
    const out = await override(randomUUID(), 1);
    expect(out).toBeNull();
    const signals = await db.select({ id: learningSignals.id }).from(learningSignals)
      .where(eq(learningSignals.accountId, accountId));
    expect(signals).toEqual([]);
  });

  it("prefers the SENDER route when both routes graduated, so one move counts once", async () => {
    await graduate(`sender:${SENDER}→${FILED_TO}`);
    await graduate(`domain:example.test→${FILED_TO}`);
    const senderRule = await promotedRule("sender", SENDER);
    await promotedRule("domain", "example.test");

    await override(randomUUID(), 1);
    const second = await override(randomUUID(), 2);
    expect(second!.patternKey).toBe(`sender:${SENDER}→${FILED_TO}`);
    expect(second!.ruleIds).toEqual([senderRule]);
    // The domain route is untouched: it did not file this mail and was never contradicted.
    const [dom] = await db.select({ graduated: graduations.graduated }).from(graduations)
      .where(and(
        eq(graduations.accountId, accountId),
        eq(graduations.patternKey, `domain:example.test→${FILED_TO}`),
      ));
    expect(dom).toEqual({ graduated: true });
  });

  it("MOVED_TO is not part of the pattern — where the person put it does not change the route", async () => {
    await graduate(`sender:${SENDER}→${FILED_TO}`);
    await promotedRule("sender", SENDER);
    for (const [i, dest] of [MOVED_TO, "ohmail.Ohbox"].entries()) {
      const out = await settled(await recordRouteOverride(tx(), accountId, {
        senderAddress: SENDER, senderDomain: "example.test", filedTo: FILED_TO,
        triggeringActionId: routeOverrideActionId(randomUUID(), `d${i}`), now: NOW,
      }));
      expect(out!.patternKey).toBe(`sender:${SENDER}→${FILED_TO}`);
      expect(dest.length).toBeGreaterThan(0);
    }
    expect(await graduatedNow()).toBe(false);
  });

  it("the override writes no rule: the switch-off waits for the door after the caller's commit", async () => {
    await graduate(`sender:${SENDER}→${FILED_TO}`);
    const ruleId = await promotedRule("sender", SENDER);
    await recordRouteOverride(tx(), accountId, {
      senderAddress: SENDER, filedTo: FILED_TO, triggeringActionId: routeOverrideActionId(randomUUID(), "1"), now: NOW,
    });
    const owed = await recordRouteOverride(tx(), accountId, {
      senderAddress: SENDER, filedTo: FILED_TO, triggeringActionId: routeOverrideActionId(randomUUID(), "2"), now: NOW,
    });
    expect(owed).toMatchObject({ demoted: true });
    const ruleNow = async () => (await db.select({ enabled: rules.enabled }).from(rules).where(eq(rules.id, ruleId)))[0];
    expect(await ruleNow(), "the override's own transaction switched the rule off").toEqual({ enabled: true });
    expect((await demoteRoute(tx(), accountId, owed!.patternKey)).ruleIds).toEqual([ruleId]);
    expect(await ruleNow()).toEqual({ enabled: false });
    expect(await graduatedNow()).toBe(false);
  });

  it("the door leaves a promoted rule a person stamped as it is, and still ends the route", async () => {
    await graduate(`sender:${SENDER}→${FILED_TO}`);
    const ruleId = await promotedRule("sender", SENDER);
    await db.update(rules).set({ personDecidedAt: NOW }).where(eq(rules.id, ruleId));
    expect((await demoteRoute(tx(), accountId, `sender:${SENDER}→${FILED_TO}`)).ruleIds).toEqual([]);
    const [rule] = await db.select({ enabled: rules.enabled, demotions: rules.demotions }).from(rules).where(eq(rules.id, ruleId));
    expect(rule, "a demotion wrote over the person's decision").toEqual({ enabled: true, demotions: 0 });
    expect(await graduatedNow()).toBe(false);
  });

  it("a route under the person's own rule is not learned, so a move away is no override of it", async () => {
    await graduate(`sender:${SENDER}→${FILED_TO}`);
    await db.insert(rules).values({ accountId, kind: "sender", match: SENDER, destination: FILED_TO, provenance: "manual", enabled: false });
    expect(await override(randomUUID(), 1)).toBeNull();
    const signals = await db.select({ id: learningSignals.id }).from(learningSignals).where(eq(learningSignals.accountId, accountId));
    expect(signals).toEqual([]);
  });

  async function graduatedNow(): Promise<boolean> {
    const rows = await db.select({ graduated: graduations.graduated }).from(graduations)
      .where(and(
        eq(graduations.accountId, accountId),
        eq(graduations.patternKey, `sender:${SENDER}→${FILED_TO}`),
      ));
    return rows[0]?.graduated ?? false;
  }

  /** A person confirming a proposal — the existing positive counter, no new mechanism. */
  async function confirm(id: string): Promise<void> {
    await recordLearningSignal(tx(), accountId, {
      triggeringActionId: `approval:${id}`, kind: "approval",
      senderAddress: SENDER, destination: FILED_TO, label: "positive",
    });
  }
});
