import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { makeTestDb } from "../src/testing.js";
import {
  ALERT_KIND_ARMS, DRIVER_NEVER_RAN, DEFAULT_ALERT_REPEAT_MS, DEFAULT_ALERT_THRESHOLDS,
  alertKindArms, alertPassRuns, evaluateAlerts, writeHeartbeat, type AlertKindArms,
} from "../src/cloud.js";
/* @reads: packages/db/src/alerts.ts packages/db/src/alert-types.ts */

/**
 * THE CENSUS OVER THE UNIONS. Every `AlertKind` carries a RESOLVE arm and a FALSE-OPEN arm, and
 * every `AlertDriver` carries a never-ran case. The unions are read out of the source, not
 * imported, so a member added without its arms is a red here and not a quiet default.
 */
const SRC = (readFileSync(new URL("../src/alert-types.ts", import.meta.url), "utf8")
  + readFileSync(new URL("../src/alerts.ts", import.meta.url), "utf8"))
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const unionOf = (name: string): string[] =>
  [...SRC.match(new RegExp(`export type ${name} =([\\s\\S]*?);`))![1]!.matchAll(/"([a-z0-9_]+)"/g)]
    .map((m) => m[1]!);

/** What the census refuses, by name. A horizon that is not a positive number is no arm. */
function armsRefusals(
  kinds: readonly string[], table: Record<string, Partial<AlertKindArms> | undefined>,
): string[] {
  const out: string[] = [];
  for (const k of kinds) {
    const a = table[k];
    if (!a) { out.push(`${k}: no arms`); continue; }
    if (typeof a.evaluated !== "function") out.push(`${k}: no RESOLVE arm`);
    const h = typeof a.unconfirmedAfterMs === "function" ? a.unconfirmedAfterMs(DEFAULT_ALERT_THRESHOLDS) : NaN;
    if (!(Number.isFinite(h) && h > 0)) out.push(`${k}: no FALSE-OPEN arm`);
  }
  for (const k of Object.keys(table)) if (!kinds.includes(k)) out.push(`${k}: arms for no kind`);
  return out;
}

function driverRefusals(drivers: readonly string[], table: Record<string, unknown>): string[] {
  const out = drivers.filter((d) => typeof table[d] !== "function").map((d) => `${d}: no never-ran case`);
  for (const d of Object.keys(table)) if (!drivers.includes(d)) out.push(`${d}: a case for no driver`);
  return out;
}

describe("every alert kind has both arms", () => {
  const kinds = unionOf("AlertKind");

  it("the union is read, and it is not empty", () => {
    expect(kinds.length, "the census reads the real union").toBeGreaterThanOrEqual(17);
  });

  it("the shipped table refuses nothing", () => {
    expect(armsRefusals(kinds, ALERT_KIND_ARMS as never)).toEqual([]);
  });

  it("POSITIVE CONTROL: a planted kind with no arms is refused by name", () => {
    expect(armsRefusals([...kinds, "planted_kind"], ALERT_KIND_ARMS as never))
      .toEqual(["planted_kind: no arms"]);
  });

  it("POSITIVE CONTROL: a kind missing either arm is refused, naming the arm", () => {
    const table: Record<string, Partial<AlertKindArms>> = { ...ALERT_KIND_ARMS };
    table.sends_stuck = { evaluated: ALERT_KIND_ARMS.sends_stuck.evaluated };
    table.sync_lag = { unconfirmedAfterMs: ALERT_KIND_ARMS.sync_lag.unconfirmedAfterMs };
    expect(armsRefusals(kinds, table).sort())
      .toEqual(["sends_stuck: no FALSE-OPEN arm", "sync_lag: no RESOLVE arm"]);
  });

  it("every horizon closes a row before the production premise can see it", () => {
    // The ruling: `open AND last_confirmed_at < now − 2 × repeat` reads 0. A row closes on the
    // first pass past its horizon, and the worker passes once a minute.
    for (const k of kinds) {
      const h = alertKindArms(k).unconfirmedAfterMs(DEFAULT_ALERT_THRESHOLDS);
      expect(h + 60_000, k).toBeLessThan(2 * DEFAULT_ALERT_REPEAT_MS);
    }
  });

  it("a kind this build does not know is never read as cleared", () => {
    const arms = alertKindArms("retired_kind");
    const scope = {
      driver: "worker" as const, shards: [0], measuredWindows: new Set<string>(),
      unread: new Set<never>(), unreadReasons: new Map<never, never>(),
    };
    expect(arms.evaluated("retired_kind", scope)).toBe(false);
    expect(arms.unconfirmedAfterMs(DEFAULT_ALERT_THRESHOLDS)).toBeGreaterThan(0);
  });
});

describe("every alert driver has a never-ran case", () => {
  const drivers = unionOf("AlertDriver");

  it("the union is read and the table refuses nothing", () => {
    expect(drivers.sort()).toEqual(["api", "worker"]);
    expect(driverRefusals(drivers, DRIVER_NEVER_RAN)).toEqual([]);
  });

  it("POSITIVE CONTROL: a planted driver with no never-ran case is refused by name", () => {
    expect(driverRefusals([...drivers, "planted_driver"], DRIVER_NEVER_RAN))
      .toEqual(["planted_driver: no never-ran case"]);
  });
});

/* ── The never-ran case, in the hosted service's shape ───────────────────────────────────── */

const NOW = new Date("2026-09-20T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function leaderUpFor(db: Db, upFor: number): Promise<void> {
  await writeHeartbeat(db, {
    shardIndex: 0, instanceId: "wkr", shards: 1, mailboxes: 1, expected: 1, accounts: 1,
    quarantined: 0, degraded: false, aiCircuitOpenSince: null,
    lastCycleAt: ago(10_000), startedAt: ago(upFor),
  }, ago(10_000));
}
async function passRow(db: Db, driver: "worker" | "api", at: Date): Promise<void> {
  await db.insert(alertPassRuns).values({
    driver, ranAt: at, firing: 0, delivered: 0, failedSinks: 0, sinkFailureStreak: 0,
  });
}
const darkKeys = async (db: Db, opts: Parameters<typeof evaluateAlerts>[1]) =>
  (await evaluateAlerts(db, { now: NOW, ...opts }))
    .filter((a) => a.kind === "alert_driver_dark").map((a) => a.key);

describe("an arm that has NEVER recorded a pass is dark once the grace has passed", () => {
  it("PRODUCTION'S SHAPE: a worker row, no api row, an API arm expected — the worker reports it", async () => {
    const db = await makeTestDb();
    await leaderUpFor(db, 6 * HOUR);
    await passRow(db, "worker", ago(MIN));
    const firing = await evaluateAlerts(db, { now: NOW, driver: "worker", shards: [], apiArmExpected: true });
    const dark = firing.find((a) => a.key === "alert_driver_dark:api");
    expect(dark, "never ran is the worst case, not a quiet one").toBeTruthy();
    expect(dark!.title).toContain("never run");
    expect(dark!.severity).toBe("critical");
  });

  it("a single-arm deployment (no API arm expected) is not paged about the arm it does not run", async () => {
    const db = await makeTestDb();
    await leaderUpFor(db, 6 * HOUR);
    await passRow(db, "worker", ago(MIN));
    expect(await darkKeys(db, { driver: "worker", shards: [] })).toEqual([]);
  });

  it("inside the grace from the leader's boot it waits", async () => {
    const db = await makeTestDb();
    await leaderUpFor(db, 10 * MIN);
    await passRow(db, "worker", ago(MIN));
    expect(await darkKeys(db, { driver: "worker", shards: [], apiArmExpected: true })).toEqual([]);
  });

  it("the API arm reports a WORKER driver that never ran while its leader is up", async () => {
    const db = await makeTestDb();
    await leaderUpFor(db, 2 * HOUR);
    await passRow(db, "api", ago(MIN));
    expect(await darkKeys(db, { driver: "api" })).toEqual(["alert_driver_dark:worker"]);
  });

  it("no live leader is worker_down's case, not this rule's", async () => {
    const db = await makeTestDb();
    await passRow(db, "api", ago(MIN));
    expect(await darkKeys(db, { driver: "api" })).toEqual([]);
  });

  it("an arm that HAS run is judged by its last pass, as before", async () => {
    const db = await makeTestDb();
    await leaderUpFor(db, 6 * HOUR);
    await passRow(db, "worker", ago(MIN));
    await passRow(db, "api", ago(HOUR));
    const firing = await evaluateAlerts(db, { now: NOW, driver: "worker", shards: [], apiArmExpected: true });
    const dark = firing.find((a) => a.key === "alert_driver_dark:api")!;
    expect(dark.title).toContain("has not run in");
  });
});
