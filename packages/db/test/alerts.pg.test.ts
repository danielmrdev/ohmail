import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { eq } from "drizzle-orm";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import {
  schema, accounts, drafts, mailboxes, outboundSends,
} from "../src/schema.js";
import {
  evaluateAlerts, runAlertPass, writeHeartbeat, refreshHeartbeat, clearHeartbeat, listStuckSends,
} from "../src/alerts.js";

/**
 * ON REAL POSTGRES — the assertions PGlite structurally cannot make.
 *
 * This file exists because of a defect it would have caught on day one and did not, because
 * it did not exist yet: `evaluateAlerts`'s sync-lag predicate compared a raw `coalesce(...)`
 * fragment against a JS `Date`. PGlite binds a `Date` happily; postgres-js serialises a raw
 * template parameter against the type Postgres describes for `$n` — TEXT — and throws
 * `ERR_INVALID_ARG_TYPE`. The unit suite was green and EVERY production alert pass died,
 * silently, inside the one code path whose entire purpose is to not fail silently.
 *
 * It is the same class of bug `mail-service.ts:reserveRecipientSlot` documents at length and
 * `auth-throttle.pg.test.ts` was written for. The rule, restated: any timestamp inside a raw
 * `sql` template goes in as an ISO STRING with an explicit `::timestamptz`, and the assertion
 * that it works belongs in a `.pg.test.ts`, never in a PGlite one.
 */

const AVAILABLE = await realPgAvailable();
const NOW = new Date("2026-07-31T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe.skipIf(!AVAILABLE)("alerts on real Postgres (driver-level parameter binding)", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
    // RESIDUE HYGIENE, and it bit for real: this suite runs against the SHARED
    // trafficflow_test database at a FIXED `NOW`, and a prior run that died between notifying
    // and resolving leaves `alert_state` rows whose `notified_at` sits AT or AFTER this run's
    // `NOW` — a state a live deployment can never be in (its clock is monotonic), and one that
    // makes the claim below never "due", so the full-pass test fails forever on data no test
    // in the current file wrote. Delete exactly that impossible population; genuinely open
    // alerts from a concurrent writer (there are none — suites hold the global advisory lock)
    // would carry past stamps and survive.
    // An ISO STRING, not a Date: this raw postgres-js tag is exactly the driver surface the
    // suite exists to exercise, and it refuses a bare Date parameter.
    await sql`delete from alert_state where notified_at >= ${new Date(NOW.getTime() - MIN).toISOString()}`;
  }, 60_000);

  it("EVERY rule executes against postgres-js without a binding error", async () => {
    // The whole point: this call is what threw in production. A rejection here is the bug.
    const alerts = await evaluateAlerts(db, { now: NOW });
    expect(Array.isArray(alerts)).toBe(true);
  });

  it("the sync-lag rule really selects rows on real Postgres, not just 'does not throw'", async () => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `alerts-${accountId.slice(0, 8)}` });
    const address = `lag-${accountId.slice(0, 8)}@example.test`;
    await db.insert(mailboxes).values({
      accountId, provider: "imap", address, status: "connected",
      lastSyncAt: ago(90 * MIN), createdAt: ago(5 * HOUR),
    });

    const alerts = await evaluateAlerts(db, { now: NOW });
    const lag = alerts.find((a) => a.kind === "sync_lag");
    expect(lag, "a 90-minute-stale mailbox must be counted by the real driver too").toBeDefined();
    expect(lag!.count).toBeGreaterThanOrEqual(1);
    // A NEGATIVE control on the same statement: `min(coalesce(...))` returned a usable value
    // rather than the string-vs-timestamptz confusion the fix is about.
    expect(lag!.oldestSeconds).not.toBeNull();
    expect(lag!.oldestSeconds!).toBeGreaterThanOrEqual(90 * 60);
  });

  /**
   * THE POPULATION MISMATCH (0021 review #10), asserted in both directions.
   *
   * `sync_lag` used to count every `status <> 'disabled'` row. The worker's roster
   * (`apps/worker/src/mailboxes.ts:loadEnabledMailboxes`) additionally drops accounts whose
   * entitlement says `syncEnabled: false`, so a paused subscription left `connected` rows that
   * NOTHING syncs, on purpose — and they crossed the fifteen-minute threshold within the hour
   * and paged a human for ever. An alert that fires for a billing state working as designed is
   * an alert people learn to filter, which is the failure the whole rule exists to prevent.
   *
   * Measured as a DELTA against the shared accumulator database rather than an absolute count:
   * these files share one Postgres and earlier tests in this very file leave stale mailboxes
   * behind. The delta is also the sharper assertion — it is about THIS mailbox.
   */
  it("a PARKED account's stale mailbox does not page; the same mailbox unparked does", async () => {
    // WHO IS PARKED IS A READER, not a query. This database has no opinion about an account's
    // standing any more: the composition that has one hands it down, and an install with none
    // parks nobody — which is the self-hosted answer and the reason the reader is optional.
    // BOTH TIERS, SUMMED. `sync_lag` emits a warning row and a critical row under one kind and
    // which one carries a given mailbox depends on how far behind it is, so a reader that took
    // the FIRST row of that kind would measure whichever tier came out first.
    const rowsOf = async (parked?: Set<string>) =>
      (await evaluateAlerts(db, {
        now: NOW,
        ...(parked ? { parkedAccounts: async (): Promise<Set<string>> => parked } : {}),
      })).filter((a) => a.kind === "sync_lag");
    const lagCount = async (parked?: Set<string>): Promise<number> =>
      (await rowsOf(parked)).reduce((n, a) => n + a.count, 0);

    const baseline = await lagCount();

    const parked = randomUUID();
    await db.insert(accounts).values({ id: parked, name: `parked-${parked.slice(0, 8)}` });
    await db.insert(mailboxes).values({
      accountId: parked, provider: "imap", address: `parked-${parked.slice(0, 8)}@example.test`,
      status: "connected", lastSyncAt: ago(90 * MIN), createdAt: ago(5 * HOUR),
    });

    expect(await lagCount(new Set([parked])), "a parked account's stale mailbox must not page")
      .toBe(baseline);

    // …and the exclusion is VISIBLE rather than silent, so an operator can reconcile the number.
    // Read across both tiers for `lagCount`'s reason: the sentence is on whichever row the
    // parked mailbox would have been counted in.
    expect(
      (await rowsOf(new Set([parked]))).some((a) => /parked/i.test(a.detail)),
      "the parked exclusion is silent — an operator cannot reconcile the count",
    ).toBe(true);

    // THE SAME ROW, unparked, DOES page. Without this the assertion above would pass just as
    // well against a rule that had stopped selecting anything.
    expect(await lagCount(), "the same mailbox must page when nobody is parked").toBe(baseline + 1);

    // And a reader that names somebody ELSE does not park this one — the set is consulted per
    // account rather than read as "somebody is parked, drop the rule".
    expect(await lagCount(new Set([randomUUID()]))).toBe(baseline + 1);
  });

  it("a QUARANTINED mailbox on a live plan still pages — it is in the roster too", async () => {
    // `status='error'` is a retry state, not a terminal one: the worker keeps it and its owner
    // is not receiving mail. Narrowing the alert to `connected` would hide the worst case.
    const lagCount = async (): Promise<number> =>
      (await evaluateAlerts(db, { now: NOW })).find((a) => a.kind === "sync_lag")?.count ?? 0;
    const before = await lagCount();
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `qtn-${accountId.slice(0, 8)}` });
    await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `qtn-${accountId.slice(0, 8)}@example.test`,
      status: "error", lastSyncAt: ago(90 * MIN), createdAt: ago(5 * HOUR),
    });
    expect(await lagCount()).toBe(before + 1);
  });

  it("`oldestSeconds` is the worst ON-DUTY mailbox, not the worst parked one", async () => {
    // The count and the age are two numbers from the same set. A parked mailbox that is a year
    // behind must not become the "worst is 400d behind" line in the page — it would send a human
    // hunting for an outage that is an account nobody is syncing on purpose.
    const accountId = randomUUID();
    // BOTH TIERS, SUMMED. `sync_lag` emits a warning row and a critical row under one kind, and
    // a mailbox a year behind is in the critical one — so a reader that took the FIRST row of
    // that kind would measure whichever tier came out first and report a rise as no rise. The
    // count is the population and the age is the worst of it, whichever tier holds them.
    const lag = async (parked?: Set<string>): Promise<{ count: number; oldest: number | null }> => {
      const rows = (await evaluateAlerts(db, {
        now: NOW,
        ...(parked ? { parkedAccounts: async (): Promise<Set<string>> => parked } : {}),
      })).filter((x) => x.kind === "sync_lag");
      return {
        count: rows.reduce((n, a) => n + a.count, 0),
        oldest: rows.reduce<number | null>((m, a) => (a.oldestSeconds != null && (m == null || a.oldestSeconds > m) ? a.oldestSeconds : m), null),
      };
    };
    const before = await lag();

    // THE AGE IS DERIVED FROM WHAT IS ALREADY HERE, a day older than the worst of it. Two
    // reasons, and the second is the one that bit: the assertions below are about THIS mailbox
    // rather than about a delta on a global maximum, and this database accumulates fixtures from
    // every case in the file AND from any earlier run of this one — a hard-coded age is equal to
    // its own leftover, so `parked < MY_AGE` fails on a mailbox this case seeded last time.
    // Strictly oldest by construction is the only reading that survives a re-run.
    const MY_AGE_S = (before.oldest ?? 0) + 24 * 3600;
    await db.insert(accounts).values({ id: accountId, name: `old-${accountId.slice(0, 8)}` });
    await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `old-${accountId.slice(0, 8)}@example.test`,
      status: "connected",
      lastSyncAt: new Date(NOW.getTime() - MY_AGE_S * 1000),   // and deliberately not syncing
      createdAt: new Date(NOW.getTime() - (MY_AGE_S + 24 * 3600) * 1000),
    });

    const after = await lag(new Set([accountId]));
    expect(after.count).toBe(before.count);
    expect(after.oldest ?? 0, "a parked mailbox became the worst age in the page")
      .toBeLessThan(MY_AGE_S);
    // ANTI-VACUITY: unparked, that same mailbox IS the worst on duty — so the two readings
    // above are the parking and not a rule that reads nothing.
    const unparked = await lag();
    expect(unparked.count).toBe(before.count + 1);
    expect(unparked.oldest ?? 0, "the worst on-duty age does not include this mailbox")
      .toBeGreaterThanOrEqual(MY_AGE_S);
  });

  it("the stuck-send rule and its listing agree, through the real driver", async () => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `sends-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `send-${accountId.slice(0, 8)}@example.test`,
      status: "connected", lastSyncAt: NOW,
    }).returning();
    const [draft] = await db.insert(drafts).values({ accountId, mailboxId: mb!.id }).returning();
    await db.insert(outboundSends).values({
      accountId, idempotencyKey: `idem-${accountId.slice(0, 8)}`, draftId: draft!.id,
      mintedMessageId: `<${accountId}@app.ohmail.app>`, status: "pending", createdAt: ago(25 * MIN),
    });

    const alerts = await evaluateAlerts(db, { now: NOW });
    const stuck = alerts.find((a) => a.kind === "sends_stuck");
    expect(stuck).toBeDefined();
    // AN EXPLICIT LIMIT, because the default one made this test a function of the accumulator.
    // `listStuckSends` defaults to 50 rows ordered by `created_at` ASC — a console page size,
    // not a property of this rule — and the shared `trafficflow_test` database has since
    // collected more than fifty pending sends from other files. The row this test seeds is the
    // NEWEST, so it fell off the end and the assertion started reporting the accumulator's
    // depth rather than whether the listing agrees with the alert. Widened, not weakened: the
    // claim is still "the seeded row is listed".
    const listed = await listStuckSends(db, ago(10 * MIN), 5_000);
    expect(listed.some((r) => r.accountId === accountId)).toBe(true);
  });

  it("a full pass writes, re-reads and clears `alert_state` on real Postgres", async () => {
    // A STUCK SEND is the condition, because it is one this database can still hold: one
    // `outbound_sends` row past the threshold, and the same row settled clears it.
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `pass-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `pass-${accountId.slice(0, 8)}@example.test`,
      status: "connected", lastSyncAt: NOW,
    }).returning();
    const [draft] = await db.insert(drafts).values({ accountId, mailboxId: mb!.id }).returning();
    const [send] = await db.insert(outboundSends).values({
      accountId, idempotencyKey: `idem-pass-${accountId.slice(0, 8)}`, draftId: draft!.id,
      mintedMessageId: `<pass-${accountId}@app.ohmail.app>`, status: "pending", createdAt: ago(25 * MIN),
    }).returning();

    const seen: string[][] = [];
    const result = await runAlertPass(db, {
      now: NOW,
      sinks: [{ name: "spy", async notify(a) { seen.push(a.map((x) => x.key)); return true; } }],
    });
    expect(result.firing.map((a) => a.kind)).toContain("sends_stuck");
    expect(seen.flat()).toContain("sends_stuck");

    // Settle it and confirm the row is resolved — the UPSERT and the resolution both work here.
    //
    // SCOPED to this file's own row: the shared accumulator holds other files' pending sends, so
    // a table-wide settle would resolve a condition this test did not create and would leave
    // their fixtures altered. (`sends_stuck` is deployment-wide, so the KEY can still be firing
    // for somebody else's row — which is why the assertion below reads the alert's own count
    // rather than requiring the key to have cleared.)
    await db.update(outboundSends).set({ status: "sent" }).where(eq(outboundSends.id, send!.id));
    const after = await runAlertPass(db, { now: new Date(NOW.getTime() + MIN), sinks: [] });
    const stillFiring = after.firing.find((a) => a.kind === "sends_stuck");
    expect(
      (stillFiring?.count ?? 0) < (result.firing.find((a) => a.kind === "sends_stuck")!.count),
      "settling the seeded send did not lower the count — the re-read is not live",
    ).toBe(true);
  });

  it("writeHeartbeat's UPSERT binds its timestamps correctly through postgres-js", async () => {
    await writeHeartbeat(db, {
      shardIndex: 99, instanceId: "pg-test", shards: 1, mailboxes: 1, expected: 1,
      accounts: 1, quarantined: 0, degraded: false, lastCycleAt: ago(MIN), startedAt: ago(HOUR),
    }, NOW);
    const alerts = await evaluateAlerts(db, { now: NOW, shards: [99] });
    expect(alerts.some((a) => a.key === "worker_down:99")).toBe(false);

    // …and an old beat on the same key fires, which proves the value round-tripped.
    await writeHeartbeat(db, {
      shardIndex: 99, instanceId: "pg-test", shards: 1, mailboxes: 1, expected: 1,
      accounts: 1, quarantined: 0, degraded: false, lastCycleAt: ago(HOUR), startedAt: ago(HOUR),
    }, ago(10 * MIN));
    const stale = await evaluateAlerts(db, { now: NOW, shards: [99] });
    expect(stale.some((a) => a.key === "worker_down:99")).toBe(true);
  });

  /* ════════════════════════════════════════════════════════════════════════════════════════
     `clearHeartbeat` IS A SURRENDER, NOT A SHARD-WIDE RESET
     ════════════════════════════════════════════════════════════════════════════════════════

     Found by an external `max`-effort review. The update was
     `WHERE shard_index = ?` alone, which let a SURRENDER clobber somebody else's CLAIM. On
     real Postgres because that is where the interleaving lives: two connections, one row, and
     the question is which predicate the planner evaluates — not whether the JS is tidy.
     ════════════════════════════════════════════════════════════════════════════════════════ */
  describe("clearHeartbeat — fenced by instance id", () => {
    const SHARD = 98;
    const beat = (instanceId: string, at: Date) => writeHeartbeat(db, {
      shardIndex: SHARD, instanceId, shards: 1, mailboxes: 2, expected: 2,
      accounts: 1, quarantined: 0, degraded: false, lastCycleAt: at, startedAt: ago(HOUR),
    }, at);
    const rowOf = async () =>
      (await db.select().from(schema.workerHeartbeats)
        .where(eq(schema.workerHeartbeats.shardIndex, SHARD)))[0]!;

    it("an outgoing worker CANNOT clear the replacement leader's heartbeat", async () => {
      // The deploy sequence, exactly as it happens: A loses its lock and queues its surrender
      // behind whatever cycle is in flight; B acquires the lock, attaches the shard's mailboxes
      // and claims the row; A's queued `clearHeartbeat` lands last.
      //
      // Unfenced, that set `leader = false` on B's row — and B's next pulse is `refreshHeartbeat`,
      // which REQUIRES `leader = true`, so it matched nothing and quietly did not beat. The
      // shard read as leaderless and paged, about a worker that was serving mail, until B's next
      // serial-queue `writeHeartbeat` upserted it back.
      await beat("wkr-A", ago(2 * MIN));
      await beat("wkr-B", ago(MIN));

      await clearHeartbeat(db, { shardIndex: SHARD, instanceId: "wkr-A" }, NOW);

      const row = await rowOf();
      expect(row.instanceId).toBe("wkr-B");
      expect(row.leader, "the live leader was surrendered by its predecessor").toBe(true);
      expect(row.beatAt.getTime(), "and its beat was not dragged forward either")
        .toBe(ago(MIN).getTime());
      expect(await evaluateAlerts(db, { now: NOW, shards: [SHARD] }))
        .not.toContainEqual(expect.objectContaining({ key: `worker_down:${SHARD}` }));
    });

    it("…and B's guarded refresh still lands, which is the half the fence exists to protect", async () => {
      await beat("wkr-A", ago(2 * MIN));
      await beat("wkr-B", ago(MIN));
      await clearHeartbeat(db, { shardIndex: SHARD, instanceId: "wkr-A" }, NOW);

      await refreshHeartbeat(db, {
        shardIndex: SHARD, instanceId: "wkr-B", mailboxes: 7, expected: 7,
        accounts: 2, quarantined: 0, degraded: false, lastCycleAt: NOW,
      }, NOW);

      const row = await rowOf();
      expect(row.mailboxes, "the replacement leader's pulse matched nothing").toBe(7);
      expect(row.beatAt.getTime()).toBe(NOW.getTime());
    });

    it("THE CONTROL: the instance that owns the row does surrender it", async () => {
      await beat("wkr-solo", ago(MIN));
      await clearHeartbeat(db, { shardIndex: SHARD, instanceId: "wkr-solo" }, NOW);

      const row = await rowOf();
      expect(row.leader).toBe(false);
      expect(row.beatAt.getTime()).toBe(NOW.getTime());
      expect((await evaluateAlerts(db, { now: NOW, shards: [SHARD] }))
        .some((a) => a.key === `worker_down:${SHARD}`)).toBe(true);
    });
  });

  it("the resolution notice's claim and settle bind through postgres-js, and tell once", async () => {
    // One resolved row of this test's own key, past the flap floor; the sink accepts only it, so
    // a co-tenant's owed notice is refused and keeps its count rather than being spent here.
    const key = `sends_stuck:pg-notice-${randomUUID().slice(0, 8)}`;
    await sql`insert into alert_state (alert_key, kind, severity, opened_at, last_seen_at,
      resolved_at, notified_at, notify_count, cls)
      values (${key}, 'sends_stuck', 'critical', ${ago(5 * HOUR).toISOString()}::timestamptz,
        ${ago(2 * HOUR).toISOString()}::timestamptz, ${ago(2 * HOUR).toISOString()}::timestamptz,
        ${ago(3 * HOUR).toISOString()}::timestamptz, 2, 'incident')`;
    try {
      const told: string[] = [];
      const sink = {
        name: "spy",
        async notify() { return true; },
        async notifyResolved(n: readonly { key: string }[]) {
          if (n[0]!.key !== key) return false;
          told.push(n[0]!.key);
          return true;
        },
      };
      const first = await runAlertPass(db, { now: NOW, sinks: [sink], shards: [] });
      expect(first.resolutionsTold).toContain(key);
      await runAlertPass(db, { now: new Date(NOW.getTime() + MIN), sinks: [sink], shards: [] });
      expect(told, "told once, then spent").toEqual([key]);
      const [row] = await sql`select notify_count, claimed_until from alert_state where alert_key = ${key}`;
      expect(Number(row!.notify_count)).toBe(0);
      expect(row!.claimed_until, "the settle released its lease").toBeNull();
    } finally {
      await sql`delete from alert_state where alert_key = ${key}`;
    }
  });
});
