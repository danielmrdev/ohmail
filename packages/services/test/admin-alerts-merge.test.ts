import { describe, it, expect } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { alertState, platformSignals, writeHeartbeat } from "@trafficflow/db/cloud";
import { adminAlerts } from "../src/admin-service.js";

/**
 * WHAT THE CONSOLE'S ALERT READ MAY AND MAY NOT ADD BACK.
 *
 * `adminAlerts` evaluates the rules live and then MERGES persisted rows for the handful of rules
 * a driverless, blind-role read structurally cannot evaluate. The merge is the right idea and its
 * first cut asked the wrong question: it matched on the KIND being scoped, which is not the same
 * claim as "this read could not evaluate it".
 *
 * `evaluateAlerts` defaults to shard 0, so this read DOES evaluate the three shard-keyed rules for
 * that shard. When shard 0 recovers but the driver has not yet deleted the row, their absence from
 * the firing set is the correct answer — and merging them back put a CLEARED CRITICAL on the board
 * until the next driver pass. That is the same false-health rendering this whole surface keeps
 * producing, arriving through a repair for it.
 */
const NOW = new Date("2026-09-04T12:07:31.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

async function healthyLeader(db: Parameters<typeof writeHeartbeat>[0]): Promise<void> {
  await writeHeartbeat(db, {
    shardIndex: 0, instanceId: "wkr", shards: 1,
    mailboxes: 1, expected: 1, accounts: 1, quarantined: 0,
    degraded: false, aiCircuitOpenSince: null,
    lastCycleAt: ago(10_000), startedAt: ago(3_600_000),
  }, ago(10_000));
}

const seedRow = async (
  db: never, key: string, kind: string,
  over: { title?: string; count?: number } = {},
): Promise<void> => {
  await (db as unknown as { insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } })
    .insert(alertState).values({
      alertKey: key, kind, severity: "critical", openedAt: ago(3_600_000),
      lastSeenAt: ago(3_600_000), notifiedAt: ago(3_600_000), notifyCount: 1,
      // A detail whose first sentence is DELIBERATELY not the title, so a reconstruction shows.
      detail: "A first sentence nobody should read as a heading. The rest of the paragraph.",
      cls: "incident",
      title: over.title ?? null, count: over.count ?? null,
    });
};

describe("the console's alert read merges only what it could not evaluate", () => {
  it("does NOT restore a shard-keyed row it evaluated and found clear", async () => {
    // THE DEFECT. Shard 0 has recovered; the driver has not yet deleted its row. This read
    // evaluated shard 0 and correctly omitted the key, and the merge put it back anyway.
    const db = await makeTestDb();
    await healthyLeader(db);
    for (const kind of ["worker_down", "worker_degraded", "ai_provider_down"]) {
      await seedRow(db as never, `${kind}:0`, kind);
    }

    const alerts = await adminAlerts(db as never, NOW);
    const keys = alerts.map((a) => a.key);
    expect(keys, "a cleared critical must not be drawn from a stale row").toEqual(
      keys.filter((k) => !k.endsWith(":0")),
    );
    for (const kind of ["worker_down", "worker_degraded", "ai_provider_down"]) {
      expect(keys, `${kind}:0 was evaluated and found clear`).not.toContain(`${kind}:0`);
    }
  });

  it("DOES restore the driver-keyed rows, which no driverless read can evaluate", async () => {
    // The other half, and the reason the merge exists at all: both of these are gated on a
    // driver name that this read never supplies, so their absence from the firing set carries
    // no information and the persisted row is the only evidence there is.
    const db = await makeTestDb();
    await healthyLeader(db);
    await seedRow(db as never, "schema_behind:worker", "schema_behind");
    await seedRow(db as never, "alert_driver_dark:api", "alert_driver_dark");

    const keys = (await adminAlerts(db as never, NOW)).map((a) => a.key);
    expect(keys).toContain("schema_behind:worker");
    expect(keys).toContain("alert_driver_dark:api");
  });

  it("PROJECTS the persisted title and count — it does not rebuild them from the detail", async () => {
    // THE FAMILY THIS CLOSES. This branch used to invent both: the count as a hardcoded 1, the
    // title as the detail's FIRST SENTENCE. So a burst of forty refusals rendered as "1" under a
    // heading that was the opening clause of a paragraph — and this is not the exceptional path,
    // it is the ONLY path for the two driver-keyed rules and the role-scoped one.
    const db = await makeTestDb();
    await healthyLeader(db);
    await seedRow(db as never, "imap_admission_refused", "imap_admission_refused", {
      title: "IMAP admission refused 40 connection(s) in the last 15m", count: 40,
    });

    const alert = (await adminAlerts(db as never, NOW))
      .find((a) => a.key === "imap_admission_refused")!;
    expect(alert, "the row is merged, because this read cannot evaluate it").toBeTruthy();
    expect(alert.title, "the RULE's title").toBe("IMAP admission refused 40 connection(s) in the last 15m");
    expect(alert.count, "the RULE's count — not 1").toBe(40);
    expect(alert.title, "and not the detail's first sentence")
      .not.toContain("A first sentence nobody should read");
  });

  it("says SO when the row predates those columns, rather than fabricating a heading", async () => {
    const db = await makeTestDb();
    await healthyLeader(db);
    await seedRow(db as never, "schema_behind:worker", "schema_behind");

    const alert = (await adminAlerts(db as never, NOW))
      .find((a) => a.key === "schema_behind:worker")!;
    expect(alert.title, "named as unevaluable rather than invented")
      .toContain("recorded by the other alert driver");
    expect(alert.count, "absent, not 1").toBe(0);
  });

  it("DOES restore a shard-keyed row for a shard OUTSIDE the set this read used", async () => {
    // The boundary between the two cases above. Shard 4 is not in this read's shard set, so it
    // was never evaluated and its row is the only evidence.
    const db = await makeTestDb();
    await healthyLeader(db);
    await seedRow(db as never, "worker_down:4", "worker_down");

    const keys = (await adminAlerts(db as never, NOW)).map((a) => a.key);
    expect(keys, "unevaluated is not the same as cleared").toContain("worker_down:4");
  });

  it("an UNMEASURED 5xx window restores the open row with its last confirmation", async () => {
    // A sampled bucket is not a measurement: the rule stays silent, and silence here used to
    // render as healthy. The row comes back with the age of its last confirmation instead.
    const db = await makeTestDb();
    await healthyLeader(db);
    await (db as unknown as { insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } })
      .insert(platformSignals).values({
        provider: "vercel", project: "ohmail-api", windowStart: ago(5 * 60_000),
        requests: 900, errors5xx: 40, truncated: true, sampleCause: "page_budget", fetchedAt: ago(4 * 60_000),
      });
    await seedRow(db as never, "api_5xx_rate:vercel:ohmail-api", "api_5xx_rate");

    const alert = (await adminAlerts(db as never, NOW)).find((a) => a.key === "api_5xx_rate:vercel:ohmail-api");
    expect(alert, "not measured is not healthy").toBeTruthy();
    expect(alert!.lastConfirmedAt, "the row's own confirmation, not this read's instant")
      .toBe(ago(3_600_000).toISOString());
  });

  it("restores storage_at_cap — this read states no at-cap population, so it cannot clear one", async () => {
    const db = await makeTestDb();
    await healthyLeader(db);
    await seedRow(db as never, "storage_at_cap", "storage_at_cap");
    const keys = (await adminAlerts(db as never, NOW)).map((a) => a.key);
    expect(keys).toContain("storage_at_cap");
  });

  it("a rule this read evaluated and saw firing is confirmed NOW", async () => {
    const db = await makeTestDb();
    // No leader at all: this read evaluates shard 0 and `worker_down:0` fires.
    const alert = (await adminAlerts(db as never, NOW)).find((a) => a.key === "worker_down:0");
    expect(alert).toBeTruthy();
    expect(alert!.lastConfirmedAt).toBe(NOW.toISOString());
  });
});
