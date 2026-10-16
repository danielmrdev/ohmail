import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { schema, alertState, alertPassRuns, workerHeartbeats } from "../src/schema.js";
import { runAlertPass, writeHeartbeat, type Alert, type AlertSink } from "../src/alerts.js";

/**
 * ── TWO DRIVERS WRITING ONE ROW, ON REAL POSTGRES ────────────────────────────────────────
 *
 * The alerting has two arms by design and nothing serialises their evaluations, so a pass that
 * read the world at 12:00 can reach the database after one that read it at 12:01. Both defects
 * below are that reordering, and each is a real page or a real silence.
 *
 * NEITHER IS REACHABLE ON PGlite — one connection, so two "overlapping" passes queue in the
 * driver and the interleaving under test never happens. That is why this is a `*.pg.test.ts`,
 * which is the standing rule here for concurrency work.
 *
 * ── AND WHY THERE IS NO INJECTED EVALUATOR ───────────────────────────────────────────────
 *
 * The first draft of this file passed an `evaluate` option to `runAlertPass` to control what
 * each pass "saw". No such option exists, so it was silently ignored, the real evaluator ran,
 * and all three tests would have passed while proving nothing. They now drive a REAL rule
 * (`worker_down`, which fires whenever a shard has no live leader) and set the persisted state
 * the stale pass is racing against. Nothing about the production path is bent to be observed.
 */
const AVAILABLE = await realPgAvailable();
const NOW = new Date("2026-08-01T12:00:00.000Z");
const MIN = 60_000;
const SHARD = 91;
const KEY = `worker_down:${SHARD}`;

function spy(name: string): AlertSink & { keys: string[] } {
  const keys: string[] = [];
  return { name, keys, async notify(alerts: readonly Alert[]) {
    for (const a of alerts) keys.push(a.key);
    return true;
  } };
}

describe.skipIf(!AVAILABLE)("an older alert observation cannot overwrite a newer one", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // `max: 4`, for the reason the neighbouring pg suite gives: one connection would serialise
    // the passes in the driver and never contend the row lock that is the subject here.
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  beforeEach(async () => {
    await db.delete(alertState).where(eq(alertState.alertKey, KEY));
    await db.delete(alertPassRuns);
    // AND THE HEARTBEATS. `worker_down` fires because shard 91 has no live leader, so a case
    // that seeds one — the stale-resolution test below needs a HEALTHY shard to have something
    // to resolve — silently disarms every case after it: the rule stops firing, no row is
    // opened, and the failures read as "the fence deleted my row" rather than "the fixture did".
    // Two cases went red that way, including a control that predates this file's fences.
    await db.delete(workerHeartbeats);
  });

  const row = async () =>
    (await db.select().from(alertState).where(eq(alertState.alertKey, KEY)))[0];

  /** The state a NEWER pass has already written, which a stale pass must not undo. */
  const seedNewer = async (over: { cls: "incident" | "signal"; count: number }): Promise<void> => {
    await db.insert(alertState).values({
      alertKey: KEY, kind: "worker_down", severity: "critical",
      openedAt: new Date(NOW.getTime() - 60 * MIN),
      // AHEAD of the stale pass's `now` — this is the whole fixture: the row carries a newer
      // observation than the pass that is about to arrive.
      lastSeenAt: new Date(NOW.getTime() + 5 * MIN),
      notifiedAt: new Date(NOW.getTime() - 2 * MIN), notifyCount: 1,
      notifiedSignature: `${over.cls}|${over.count}`,
      detail: "written by the newer pass. Second sentence.",
      title: `${over.count} shard(s) without a leader`,
      count: over.count, cls: over.cls,
    } as never);
  };

  it("A STALE PASS DOES NOT OVERWRITE the newer observation's class, count or page record", async () => {
    // The row holds a newer incident. A pass whose `now` is a minute EARLIER then fires
    // `worker_down` for the same shard — shard 91 has no heartbeat, so the rule really fires.
    // Unconditionally, its observation would rewrite title, count and detail, and any class
    // change would additionally clear the notification state and lease of a live page.
    await seedNewer({ cls: "incident", count: 7 });

    const sink = spy("stale");
    await runAlertPass(db, {
      now: new Date(NOW.getTime() - MIN), sinks: [sink], driver: "api", shards: [SHARD],
    });

    const after = await row();
    expect(after, "the row survives").toBeTruthy();
    expect(Number(after!.count), "the NEWER count stands — the stale pass wrote 1").toBe(7);
    expect(after!.title, "and the newer title").toBe("7 shard(s) without a leader");
    expect(after!.notifiedAt, "the page the newer pass sent is still recorded").not.toBeNull();
    expect(Number(after!.notifyCount)).toBe(1);
  });

  it("THE CLAIM RE-READS THE CLASS UNDER ITS LOCK, so a demotion mid-flight stops the page",
    async () => {
      // The row is a SIGNAL carrying a newer observation, which is the state a demotion between
      // another pass's evaluation and its claim produces. The arriving pass evaluates
      // `worker_down` — an INCIDENT — so the loop's own class check passes; only the locked read
      // can refuse. Without the re-read this paged a human about a condition that had cleared.
      await seedNewer({ cls: "signal", count: 4 });
      await db.update(alertState).set({ notifiedAt: null, notifyCount: 0, notifiedSignature: null })
        .where(eq(alertState.alertKey, KEY));

      const sink = spy("late");
      await runAlertPass(db, {
        now: new Date(NOW.getTime() - MIN), sinks: [sink], driver: "api", shards: [SHARD],
      });

      expect(sink.keys, "the locked row said signal, so nothing was paged").not.toContain(KEY);
      expect((await row())!.cls, "and the stale pass did not re-promote it").toBe("signal");
    });

  it("A STALE RESOLUTION DOES NOT DELETE the newer observation — or its notification", async () => {
    // THE WRITER THE FIRST FENCE MISSED. An older pass that evaluated this key as healthy reached
    // an UNCONDITIONAL delete, so it erased a newer pass's observation AND the notified_at beside
    // it — after which the next pass opened the same condition and paged a human a second time
    // for something that had never stopped. The delete is a write like any other.
    await seedNewer({ cls: "incident", count: 7 });
    // A live leader for the shard, so `worker_down` does NOT fire for this pass and the key goes
    // into its resolution set. That is the whole fixture: a stale pass that thinks it is healthy.
    await writeHeartbeat(db, {
      shardIndex: SHARD, instanceId: "wkr-live", shards: 1,
      mailboxes: 1, expected: 1, accounts: 1, quarantined: 0,
      degraded: false, aiCircuitOpenSince: null,
      lastCycleAt: new Date(NOW.getTime() - 5_000), startedAt: new Date(NOW.getTime() - 60 * MIN),
    }, new Date(NOW.getTime() - 5_000));

    await runAlertPass(db, {
      now: new Date(NOW.getTime() - MIN), sinks: [spy("stale")], driver: "api", shards: [SHARD],
    });

    const after = await row();
    expect(after, "the newer observation survives a stale pass's resolution").toBeTruthy();
    expect(after!.notifiedAt, "and so does the record that it was paged").not.toBeNull();
  });

  it("A STALE CLAIM DOES NOT PAGE — the newer text wins, not the older one", async () => {
    // The claim read `last_seen_at` under its own lock and ignored it. An older pass could lose
    // the observation upsert to a newer one — that fence worked — and still arrive here first,
    // take the lease and deliver ITS text: the older count, the older detail. The newer pass then
    // found the lease held and stayed quiet, so the operator got exactly one page and it was the
    // stale one. Silence for the newer pass AND the wrong page for the older is the worst of both.
    await seedNewer({ cls: "incident", count: 7 });
    await db.update(alertState).set({ notifiedAt: null, notifyCount: 0, notifiedSignature: null })
      .where(eq(alertState.alertKey, KEY));

    const sink = spy("stale");
    await runAlertPass(db, {
      now: new Date(NOW.getTime() - MIN), sinks: [sink], driver: "api", shards: [SHARD],
    });

    expect(sink.keys, "an older pass may not page over a newer observation").not.toContain(KEY);
    expect(Number((await row())!.count), "and the newer count still stands").toBe(7);
  });

  it("BUT AN OBSERVATION DURING DELIVERY DOES NOT LOSE THE PAGE — the settle is fenced on the lease",
    async () => {
      // The deliberate exemption, tested so nobody "tightens" it. Delivery takes seconds; the
      // other arm observes the same live condition in that window and advances `last_seen_at`
      // correctly. If the settle were fenced on the stamp it would be refused, `notified_at`
      // would stay null, and the next pass would page again for what was just paged — routine
      // overlap turned into duplicate paging.
      //
      // The sink here IS the concurrent arm: it advances the row mid-delivery, which is exactly
      // the interleaving the stamp fence would have caught and must not.
      const advancing: AlertSink = {
        name: "concurrent",
        async notify() {
          await db.update(alertState)
            .set({ lastSeenAt: new Date(NOW.getTime() + 10 * MIN) })
            .where(eq(alertState.alertKey, KEY));
          return true;
        },
      };
      await runAlertPass(db, { now: NOW, sinks: [advancing], driver: "api", shards: [SHARD] });

      const after = await row();
      expect(after, "the row is still open — the condition has not cleared").toBeTruthy();
      expect(after!.notifiedAt, "and the delivery IS recorded, so nobody is paged twice")
        .not.toBeNull();
    });

  it("A CURRENT pass DOES apply and DOES page — the fence is not simply always-off", async () => {
    // The control. Without it both assertions above are satisfied by a pass that does nothing at
    // all, which is exactly how a fence this strict could pass while being broken.
    const sink = spy("current");
    await runAlertPass(db, {
      now: NOW, sinks: [sink], driver: "api", shards: [SHARD],
    });

    const after = await row();
    expect(after, "a first observation opens the row").toBeTruthy();
    expect(after!.cls).toBe("incident");
    expect(sink.keys, "and it pages").toContain(KEY);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   The same reordering, one table over: the row each driver writes about its own pass
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe.skipIf(!AVAILABLE)("an older pass cannot overwrite a newer pass's own record", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  beforeEach(async () => {
    await db.delete(alertState);
    await db.delete(alertPassRuns);
  });

  const passRow = async () =>
    (await db.select().from(alertPassRuns).where(eq(alertPassRuns.driver, "api")))[0];

  /**
   * Two passes of ONE driver, finishing out of order.
   *
   * Nothing serialises them: the API arm is poked by a scheduler whose retry can arrive while
   * the first call is still running, and the worker arm runs on an interval that starts the next
   * pass whether or not the last one finished. The row is what the Reliability panel reads to
   * decide whether a driver is alive and whether its sinks are healthy, so an older snapshot
   * landing last does not merely rewind a timestamp — it reports a live driver as stale.
   */
  it("A STALE PASS DOES NOT REWIND ran_at OR THE COUNTS the newer pass recorded", async () => {
    // The newer pass sees TWO shards without a leader; the stale one, arriving after it, sees a
    // single shard. Both really fire `worker_down` — no evaluator is injected here either.
    await runAlertPass(db, { now: NOW, sinks: [spy("newer")], driver: "api", shards: [SHARD, SHARD + 1] });
    const newer = await passRow();
    expect(Number(newer!.firing), "the newer pass found two shards down").toBeGreaterThanOrEqual(2);

    await runAlertPass(db, {
      now: new Date(NOW.getTime() - 5 * MIN), sinks: [spy("stale")], driver: "api", shards: [SHARD],
    });

    const after = await passRow();
    expect(after!.ranAt.getTime(), "the stamp does not walk backwards").toBe(NOW.getTime());
    expect(Number(after!.firing), "nor do the counts revert to the older snapshot")
      .toBe(Number(newer!.firing));
  });

  it("A NEWER pass DOES replace the row — the fence is not simply always-off", async () => {
    // The control. Both drivers write this row on every pass, so a fence that rejected
    // everything would freeze the panel on the first pass after a deploy and look identical to
    // a healthy one for as long as nobody checked the clock.
    await runAlertPass(db, {
      now: new Date(NOW.getTime() - 5 * MIN), sinks: [spy("first")], driver: "api", shards: [SHARD],
    });
    await runAlertPass(db, { now: NOW, sinks: [spy("second")], driver: "api", shards: [SHARD, SHARD + 1] });

    const after = await passRow();
    expect(after!.ranAt.getTime(), "the later pass owns the row").toBe(NOW.getTime());
    expect(Number(after!.firing)).toBeGreaterThanOrEqual(2);
  });
});
