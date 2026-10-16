import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { recordApiFault, type ApiFaultArm } from "../src/api-faults.js";
import { evaluateAlerts, runAlertPass } from "../src/alerts.js";

/**
 * THE WORKER'S FAILED ENTITLEMENTS CALLS ARE JUDGED IN MINUTES (REVIEW-026 H1). The worker writes
 * one row per path per minute, and a floor of ten CALLS read nine minutes of outage as nothing and
 * sat a continuous one on its edge. The worker's reading is distinct failing minutes, with its own
 * floor; the API host's per-call reading is unchanged.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const NOW = new Date("2026-09-29T08:00:30.000Z");
const MIN = 60_000;
const ROUTE = "entitlements:/v1/access";
const KEY = `api_fault_rate:worker:${ROUTE}`;

const fault = (db: Db, at: Date, arm: ApiFaultArm = "worker") => recordApiFault(db, {
  route: ROUTE, method: "POST", status: 504, errorClass: "EntitlementsCallTimeout",
  requestId: null, arm, at,
});
/** One row in each of these minutes back from NOW, five seconds past the minute's first call. */
async function minutesBack(db: Db, ks: readonly number[], perMinute = 1): Promise<void> {
  for (const k of ks) for (let p = 0; p < perMinute; p++) await fault(db, new Date(NOW.getTime() - k * MIN - 5_000));
}
const fired = async (db: Db, now = NOW) => (await evaluateAlerts(db, { now })).find((a) => a.key === KEY);

describe("the worker's entitlements fault reading counts failing minutes", () => {
  it("nine failing minutes open the worker's key", async () => {
    const db = await makeTestDb();
    await minutesBack(db, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await fired(db))?.title)
      .toBe("calls from the worker to the entitlements program failed in 9 separate minute(s)");
  });

  it("three failing minutes open it; two do not", async () => {
    const three = await makeTestDb();
    await minutesBack(three, [0, 3, 6]);
    expect((await fired(three))?.count).toBe(3);
    const two = await makeTestDb();
    await minutesBack(two, [0, 4]);
    expect(await fired(two)).toBeUndefined();
  });

  it("two worker processes writing the same minutes count each minute once", async () => {
    const db = await makeTestDb();
    await minutesBack(db, [0, 1, 2, 3, 4], 2);
    const hit = await fired(db);
    expect(hit?.count).toBe(5);
    expect(hit?.title).toContain("failed in 5 separate minute(s)");
  });

  it("the API host's per-call reading is unchanged: nine calls in one minute page nobody, ten do", async () => {
    const nine = await makeTestDb();
    for (let i = 0; i < 9; i++) await fault(nine, new Date(NOW.getTime() - 20_000), "api");
    expect((await evaluateAlerts(nine, { now: NOW })).some((a) => a.key === `api_fault_rate:api:${ROUTE}`)).toBe(false);
    const ten = await makeTestDb();
    for (let i = 0; i < 10; i++) await fault(ten, new Date(NOW.getTime() - 20_000), "api");
    expect((await evaluateAlerts(ten, { now: NOW })).find((a) => a.key === `api_fault_rate:api:${ROUTE}`)?.title)
      .toBe("calls from the API host to the entitlements program failed 10 times");
  });

  it("a continuous outage stays open across minute-offset jitter: no pass resolves it", async () => {
    const db = await makeTestDb();
    const start = new Date("2026-09-29T07:00:00.000Z").getTime();
    // Each minute's first failed call lands early for ten minutes, then late for ten. A pass at
    // :30 then reads the minute that entered late and the one that left early — nine rows by the
    // call floor, so it cleared and re-opened; by minutes it never nears its floor.
    const rowAt = (m: number) => new Date(start + m * MIN + (m % 20 < 10 ? 2 : 58) * 1000);
    let planted = 0;
    const resolvedAt: string[] = [];
    const openAt: number[] = [];
    for (let p = 0; p < 30; p++) {
      const at = new Date(start + (p + 3) * MIN + 30_000);
      while (rowAt(planted).getTime() <= at.getTime()) { await fault(db, rowAt(planted)); planted++; }
      const r = await runAlertPass(db, { now: at, sinks: [], shards: [] });
      if (r.firing.some((a) => a.key === KEY)) openAt.push(p);
      if (r.resolved.includes(KEY)) resolvedAt.push(at.toISOString());
    }
    expect(resolvedAt, "never resolved while every minute keeps failing").toEqual([]);
    expect(openAt, "open on every pass from the third failing minute").toEqual(Array.from({ length: 30 }, (_, p) => p));
  });
});
