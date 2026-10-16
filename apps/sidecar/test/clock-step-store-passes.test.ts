import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "@trafficflow/db";
import { LOCAL_RETENTION_EVERY_MS, localRetentionDue, runLocalRetention } from "../src/local-retention.js";
import { createAttentionClock, PERSON_QUIET_MS } from "../src/attention.js";
import { createHostPower, HOST_POWER_READ_EVERY_MS } from "../src/host-power.js";

/*
 * THE STORE-ONLY PASSES' CLOCKS UNDER A WALL CLOCK STEPPED BACK AN HOUR. Each asks "how long since"
 * on its default clock, which is monotonic: the hourly retention, the person-quiet gate every
 * store-only pass waits on, and the power reading's cache. The fake clock moves `performance.now()`
 * with the timers; `setSystemTime` steps the wall clock alone.
 */
const HOUR = 60 * 60_000;

afterEach(() => { vi.useRealTimers(); });

/** Real time passes by `elapsedMs`, and the wall clock is stepped back by `stepMs` on the way. */
function elapse(elapsedMs: number, stepMs: number): void {
  const wall = Date.now();
  vi.advanceTimersByTime(elapsedMs);
  vi.setSystemTime(wall + elapsedMs - stepMs);
}

describe("store-only pass clocks under a wall clock stepped back an hour", () => {
  it("the hourly retention is due an hour after it ran, despite the step", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const db = {};
    await runLocalRetention(db as Tx, "acct", new Date(), () => undefined);
    expect(localRetentionDue(db), "due straight after a run").toBe(false);
    elapse(LOCAL_RETENTION_EVERY_MS + 60_000, HOUR);
    expect(localRetentionDue(db), "the retention was skipped for the clock's step").toBe(true);
  });

  it("the hourly retention is due after a suspend: the wall clock moved, the monotonic one did not", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const db = {};
    await runLocalRetention(db as Tx, "acct", new Date(), () => undefined);
    vi.advanceTimersByTime(60_000);
    vi.setSystemTime(Date.now() + 8 * HOUR);   // asleep: only the wall clock counts it
    expect(localRetentionDue(db), "the retention waited an awake hour after the sleep").toBe(true);
  });

  it("a run stamped ahead of the wall clock (the clock stepped back since) is due now", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const db = {};
    await runLocalRetention(db as Tx, "acct", new Date(), () => undefined);
    elapse(60_000, HOUR);                       // a minute later, an hour behind the stamp
    expect(localRetentionDue(db), "a stamp in the future read as not yet due").toBe(true);
  });

  it("CONTROL: inside its hour the retention is not due", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const db = {};
    await runLocalRetention(db as Tx, "acct", new Date(), () => undefined);
    elapse(LOCAL_RETENTION_EVERY_MS / 2, 0);
    expect(localRetentionDue(db)).toBe(false);
  });

  it("a person quiet for longer than the gate reads quiet, despite the step", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    const attention = createAttentionClock();
    attention.note("GET", "/messages");
    expect(attention.quietForMs(), "a person request was not noted, so this case proves nothing").toBeLessThan(PERSON_QUIET_MS);
    elapse(PERSON_QUIET_MS + 1_000, HOUR);
    expect(attention.quietForMs(), "the store-only passes waited out the clock's step").toBeGreaterThanOrEqual(PERSON_QUIET_MS);
  });

  it("the power reading is re-read once its cache has aged, despite the step", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    let reads = 0;
    const power = createHostPower({ readState: () => { reads += 1; return "ac"; } });
    power();
    power();
    expect(reads, "CONTROL: the cache answered the second ask").toBe(1);
    elapse(HOST_POWER_READ_EVERY_MS + 1_000, HOUR);
    power();
    expect(reads, "a stale power reading was served for the clock's step").toBe(2);
  });
});
