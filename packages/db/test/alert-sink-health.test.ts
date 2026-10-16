import { describe, it, expect } from "vitest";
import { managedDomain } from "../../../test/support/fixture-credentials.js";
import { makeTestDb } from "../src/testing.js";
import { accounts, outboundSends,} from "@trafficflow/db";
import {
  runAlertPass, writeHeartbeat, newDeliveryStreak, sinkHealthOf, classifyTransportError,
  DEFAULT_SINK_FAILURE_ESCALATION,
  type Alert, type AlertSink,
} from "../src/alerts.js";

/**
 * ── THE HOLE A SECOND VENDOR OPENS, WHICH ONE VENDOR COULD NOT HAVE ──────────────────────
 *
 * The pager's failure memory was a single counter cleared by ANY sink's success. With one arm
 * that is exactly right: one arm's failure IS total failure. Add a second vendor and the same
 * rule inverts — an arm that has refused every delivery for a month has its streak cleared,
 * every pass, by the OTHER arm's success. The deployment reports a healthy two-arm pager, is
 * told nothing, and in fact has one arm: the single-vendor state redundancy was bought to
 * leave, now invisible rather than merely bad.
 *
 * These are the guards for the per-arm memory that closes it, and for the two alarms staying
 * disjoint: `escalate` is "nothing reached anybody", `sinkDegraded` is "a page landed and an
 * arm is dead". They must never fire together for one silence, or the real one gets filtered.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const NOW = new Date("2026-08-22T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A world with one real, permanently-firing alert to try to deliver — a send stuck in
 *  `pending` past its threshold, which fires from one planted row and needs no metering. */
async function seedFiring(db: Db): Promise<void> {
  const [acct] = await db.insert(accounts).values({ name: "SinkHealth" }).returning();
  await writeHeartbeat(db, {
    shardIndex: 0, instanceId: "wkr-test", shards: 1,
    mailboxes: 0, expected: 0, accounts: 1, quarantined: 0, degraded: false,
    lastCycleAt: NOW, startedAt: new Date(NOW.getTime() - HOUR),
  }, NOW);
  await db.insert(outboundSends).values({
    accountId: acct!.id,
    idempotencyKey: "idem-sink-health",
    mintedMessageId: `<sink-health@app.${managedDomain()}>`,
    status: "pending",
    createdAt: new Date(NOW.getTime() - HOUR),
  });
}

function refusing(name: string, error: string, outcome?: "refused" | "unreachable"): AlertSink {
  return { name, notify: () => Promise.resolve({ ok: false, error, outcome }) };
}

function accepting(name: string): AlertSink & { seen: Alert[][] } {
  const seen: Alert[][] = [];
  return { name, seen, async notify(alerts) { seen.push([...alerts]); return true; } };
}

/** A sink whose verdict the test flips between passes. */
function switchable(name: string): AlertSink & { ok: boolean } {
  const s = {
    name, ok: false,
    notify: () => Promise.resolve(
      s.ok ? { ok: true, outcome: "ok" as const } : { ok: false, error: "HTTP 502", outcome: "refused" as const },
    ),
  };
  return s;
}

describe("per-sink health — a dead arm beside a live one must not be silent", () => {
  it("names the arm that has stopped delivering while the page still lands elsewhere", async () => {
    const db = await makeTestDb();
    await seedFiring(db);
    const streak = newDeliveryStreak();
    const mail = accepting("mail");
    const push = refusing("telegram", "TypeError: fetch failed (ETIMEDOUT)", "unreachable");

    // ONE PASS PER REPEAT INTERVAL, and that spacing is not cosmetic: a DELIVERED page
    // confirms its claim, so the same alert is not re-notified until `repeatMs` has passed.
    // The sibling file's minute-spaced loop works because every delivery there FAILS and a
    // failed delivery releases its claim — the opposite case, and the one this file is not in.
    const results = [];
    for (let i = 0; i < DEFAULT_SINK_FAILURE_ESCALATION; i++) {
      results.push(await runAlertPass(db, {
        now: new Date(NOW.getTime() + i * HOUR), sinks: [mail, push], deliveryStreak: streak,
      }));
    }

    // The page landed on every single pass, so the OLD alarm has nothing to say — which is
    // precisely why the new one has to exist.
    for (const r of results) expect(r.delivered).toEqual(["mail"]);
    for (const r of results) expect(r.escalate, "a delivered page is not an undeliverable pager").toBeNull();

    expect(
      results.slice(0, -1).flatMap((r) => r.sinkDegraded),
      "fewer than N refusals from one arm is a blip, not a lost arm",
    ).toEqual([]);

    const last = results.at(-1)!;
    expect(last.sinkDegraded, "N consecutive refusals from one arm is redundancy lost").toHaveLength(1);
    expect(last.sinkDegraded[0]!.sink).toBe("telegram");
    expect(last.sinkDegraded[0]!.consecutiveFailures).toBe(DEFAULT_SINK_FAILURE_ESCALATION);
    expect(last.sinkDegraded[0]!.outcome, "a closed code, not the vendor's prose").toBe("unreachable");
    expect(last.sinkDegraded[0]!.error).toBe("TypeError: fetch failed (ETIMEDOUT)");
    expect(
      last.sinkDegraded[0]!.survivors,
      "what redundancy is LEFT, named rather than left to be inferred",
    ).toEqual(["mail"]);
  });

  it("reports a lost arm ONCE per streak", async () => {
    const db = await makeTestDb();
    await seedFiring(db);
    const streak = newDeliveryStreak();
    const mail = accepting("mail");
    const push = refusing("telegram", "HTTP 401");

    const reports = [];
    for (let i = 0; i < DEFAULT_SINK_FAILURE_ESCALATION + 5; i++) {
      const r = await runAlertPass(db, {
        now: new Date(NOW.getTime() + i * HOUR), sinks: [mail, push], deliveryStreak: streak,
      });
      reports.push(...r.sinkDegraded);
    }
    expect(reports, "one ERROR per streak, however long the arm stays dead").toHaveLength(1);
  });

  it("an arm's OWN success clears its OWN streak, and nobody else's", async () => {
    const db = await makeTestDb();
    await seedFiring(db);
    const streak = newDeliveryStreak();
    const mail = accepting("mail");
    const push = switchable("telegram");

    // Two refusals — one short of the threshold.
    for (let i = 0; i < DEFAULT_SINK_FAILURE_ESCALATION - 1; i++) {
      await runAlertPass(db, {
        now: new Date(NOW.getTime() + i * HOUR), sinks: [mail, push], deliveryStreak: streak,
      });
    }
    expect(streak.sinks["telegram"]!.consecutiveFailures).toBe(DEFAULT_SINK_FAILURE_ESCALATION - 1);

    push.ok = true;
    const recovered = await runAlertPass(db, {
      now: new Date(NOW.getTime() + 10 * HOUR), sinks: [mail, push], deliveryStreak: streak,
    });
    expect(recovered.delivered).toEqual(["mail", "telegram"]);
    expect(streak.sinks["telegram"]!.consecutiveFailures, "its own success clears its own count").toBe(0);
    expect(streak.sinks["telegram"]!.lastOkAt).toBe(new Date(NOW.getTime() + 10 * HOUR).toISOString());

    // And a fresh streak still reaches the threshold afterwards. A day apart: after three
    // pages an unchanged critical is reminded daily, and each attempt is what the streak counts.
    push.ok = false;
    const after = [];
    for (let i = 0; i < DEFAULT_SINK_FAILURE_ESCALATION; i++) {
      const r = await runAlertPass(db, {
        now: new Date(NOW.getTime() + (10 + 25 * (i + 1)) * HOUR), sinks: [mail, push], deliveryStreak: streak,
      });
      after.push(...r.sinkDegraded);
    }
    expect(after, "a cleared streak must be able to escalate again").toHaveLength(1);
  });

  it("a total silence belongs to `escalate` alone — the two alarms never double-shout", async () => {
    const db = await makeTestDb();
    await seedFiring(db);
    const streak = newDeliveryStreak();
    const mail = switchable("mail");
    const push = refusing("telegram", "HTTP 502");

    const results = [];
    for (let i = 0; i < DEFAULT_SINK_FAILURE_ESCALATION; i++) {
      results.push(await runAlertPass(db, {
        now: new Date(NOW.getTime() + i * MIN), sinks: [mail, push], deliveryStreak: streak,
      }));
    }
    const last = results.at(-1)!;
    expect(last.delivered).toEqual([]);
    expect(last.escalate, "nothing reached anybody — this is the loud one").not.toBeNull();
    expect(
      results.flatMap((r) => r.sinkDegraded),
      "one silence must produce ONE alarm, or the real one gets filtered",
    ).toEqual([]);

    // The per-arm counters still advanced underneath, so the arm that stayed dead is named on
    // the first pass the other one comes back — which is exactly when it matters again.
    mail.ok = true;
    const recovered = await runAlertPass(db, {
      now: new Date(NOW.getTime() + 30 * MIN), sinks: [mail, push], deliveryStreak: streak,
    });
    expect(recovered.delivered).toEqual(["mail"]);
    expect(
      recovered.sinkDegraded.map((d) => d.sink),
      "the pager is back, on one arm — and that is worth saying out loud",
    ).toEqual(["telegram"]);
  });
});

describe("sinkHealthOf — an arm nobody has exercised is not an arm known to work", () => {
  it("lists every CONFIGURED sink, including one that has never been attempted", () => {
    const streak = newDeliveryStreak();
    const health = sinkHealthOf([accepting("mail"), refusing("telegram", "x")], streak);
    expect(health.map((h) => h.name)).toEqual(["mail", "telegram"]);
    for (const h of health) {
      expect(h.attempts, "zero attempts is absence of evidence, and must be visible as such").toBe(0);
      expect(h.outcome).toBeNull();
      expect(h.lastOkAt).toBeNull();
    }
  });

  it("publishes closed codes and counts, and never the vendor's sentence", async () => {
    const db = await makeTestDb();
    await seedFiring(db);
    const streak = newDeliveryStreak();
    const mail = accepting("mail");
    const push = refusing("telegram", "HTTP 400 — chat not found", "refused");

    const r = await runAlertPass(db, {
      now: NOW, sinks: [mail, push], deliveryStreak: streak,
    });

    const byName = Object.fromEntries(r.sinkHealth.map((h) => [h.name, h]));
    expect(byName["mail"]).toEqual({
      name: "mail", outcome: "ok", consecutiveFailures: 0, attempts: 1,
      lastOkAt: NOW.toISOString(),
    });
    expect(byName["telegram"]).toEqual({
      name: "telegram", outcome: "refused", consecutiveFailures: 1, attempts: 1, lastOkAt: null,
    });
    expect(
      JSON.stringify(r.sinkHealth),
      "this object is published on /health; a vendor's error prose may not ride along",
    ).not.toContain("chat not found");
  });

  it("a pass that attempted nothing neither confirms nor disturbs standing health", async () => {
    const db = await makeTestDb();
    const streak = newDeliveryStreak();
    const mail = accepting("mail");
    // Nothing is firing, so nothing is claimed and nothing is delivered. `shards: []` is the
    // worker's own configuration — a process reporting that it is alive is not evidence — and
    // without it the unseeded heartbeat table fires `worker_down` and this pass has work.
    const r = await runAlertPass(db, {
      now: NOW, shards: [], sinks: [mail], deliveryStreak: streak,
    });
    expect(r.notified).toEqual([]);
    expect(r.sinkOutcomes).toEqual([]);
    expect(r.sinkHealth).toEqual([
      { name: "mail", outcome: null, consecutiveFailures: 0, attempts: 0, lastOkAt: null },
    ]);
  });
});

describe("closed outcome codes", () => {
  it("distinguishes a deadline from a transport that never answered", () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(classifyTransportError(abort)).toBe("timeout");
    const timeoutErr = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    expect(classifyTransportError(timeoutErr)).toBe("timeout");
    const blackholed = Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
    expect(
      classifyTransportError(blackholed),
      "a host that swallows our packets is UNREACHABLE — nobody refused anything",
    ).toBe("unreachable");
    expect(classifyTransportError("not an error at all")).toBe("unreachable");
  });

  it("a sink that returns a bare boolean still gets an honest code", async () => {
    const db = await makeTestDb();
    await seedFiring(db);
    const streak = newDeliveryStreak();
    const bare: AlertSink = { name: "legacy", notify: () => Promise.resolve(false) };
    const r = await runAlertPass(db, { now: NOW, sinks: [bare], deliveryStreak: streak });
    expect(r.sinkOutcomes).toEqual([
      { sink: "legacy", ok: false, outcome: "refused", error: null },
    ]);
  });

  it("a sink that breaks its never-throws contract is coded `threw`, not blamed on the network", async () => {
    const db = await makeTestDb();
    await seedFiring(db);
    const streak = newDeliveryStreak();
    const bad: AlertSink = { name: "broken", notify: () => { throw new Error("boom"); } };
    const r = await runAlertPass(db, { now: NOW, sinks: [bad], deliveryStreak: streak });
    expect(r.sinkOutcomes[0]!.outcome).toBe("threw");
    expect(r.sinkHealth[0]!.outcome).toBe("threw");
  });
});
