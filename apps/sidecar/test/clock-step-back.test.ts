import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { boot, liar, ordinary, rig, server, type Msg } from "./_overrun-rig.js";
import { WallWait } from "../src/engine.js";
import {
  armFirstPageGate, awaitFirstPage, FIRST_PAGE_GRACE_MS, resetFirstPageGate,
} from "../src/first-page-gate.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 6 });

/*
 * FIRST-PAGE-GATE-WAITS-OUT-A-CLOCK-STEP. A wall clock stepped back after a wait was armed made the
 * wait last as long as the step: the first-page gate (every drain, for the life of a phone's
 * process), and the floor poll after a set-aside. Each wait is now bounded by its own length.
 */
const STEP_MS = 19 * 60_000;
const realNow = Date.now.bind(Date);

/** A promise's state without awaiting it — for the fake-timer cases, where no real timer runs. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  return (await Promise.race([p, Promise.resolve(marker)])) !== marker;
}

async function settledWithin<T>(p: Promise<T>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((r) => { timer = setTimeout(() => r(false), ms); });
  const done = await Promise.race([p.then(() => true as const), late]);
  clearTimeout(timer);
  return done;
}

describe("the first-page gate under a wall clock stepped back 19 minutes", () => {
  beforeEach(() => resetFirstPageGate());
  afterEach(() => { vi.restoreAllMocks(); resetFirstPageGate(); });

  it("an armed gate still waits at most the grace", async () => {
    armFirstPageGate();
    vi.spyOn(Date, "now").mockImplementation(() => realNow() - STEP_MS);
    const t = performance.now();
    const waiting = awaitFirstPage(200);
    expect(await settledWithin(waiting, 3_000), "the drain waited out the clock step").toBe(true);
    await expect(waiting).resolves.toBe("timed-out");
    expect(performance.now() - t).toBeLessThan(1_500);
  });

  it("an unarmed gate pays its grace once, and a step after it costs nothing", async () => {
    await expect(awaitFirstPage(50)).resolves.toBe("timed-out");
    vi.spyOn(Date, "now").mockImplementation(() => realNow() - STEP_MS);
    const second = awaitFirstPage(50);
    expect(await settledWithin(second, 20), "a later drain waited again after the step").toBe(true);
  });

  it("a reading behind the arm instant is clamped to the grace", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      armFirstPageGate(1_000_000);
      const waiting = awaitFirstPage(FIRST_PAGE_GRACE_MS, 1_000_000 - STEP_MS);
      await vi.advanceTimersByTimeAsync(FIRST_PAGE_GRACE_MS);
      expect(await settled(waiting), "the wait outlasted the grace by the clock's step").toBe(true);
      await expect(waiting).resolves.toBe("timed-out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("CONTROL: a real clock keeps today's timing — the full grace from the arm, what is left of it after", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      armFirstPageGate(1_000_000);
      const waiting = awaitFirstPage(FIRST_PAGE_GRACE_MS, 1_000_000 + 500);
      await vi.advanceTimersByTimeAsync(FIRST_PAGE_GRACE_MS - 501);
      expect(await settled(waiting), "the drain went before what was left of the grace").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await settled(waiting), "the drain sat past what was left of the grace").toBe(true);
      await expect(waiting).resolves.toBe("timed-out");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WallWait: a wall-clock wait a backward step cannot lengthen", () => {
  it("a reading behind the arm re-arms at the wait's own length, once", () => {
    const w = new WallWait();
    w.arm(15_000, 1_000_000);
    expect(w.left(1_000_000 - STEP_MS)).toBe(15_000);
    expect(w.left(1_000_000 - STEP_MS + 15_000)).toBe(0);
  });

  it("CONTROL: a clock moving forward keeps today's timing, and a forward step ends it early", () => {
    const w = new WallWait();
    w.arm(15_000, 1_000_000);
    expect(w.left(1_000_000)).toBe(15_000);
    expect(w.left(1_010_000)).toBe(5_000);
    expect(w.left(1_000_000 + STEP_MS)).toBe(0);
  });

  it("an unarmed or cleared wait has nothing left", () => {
    const w = new WallWait();
    expect(w.left(5)).toBe(0);
    w.arm(15_000, 0);
    w.clear();
    expect(w.left(0)).toBe(0);
  });
});

describe("the floor poll after a set-aside under a wall clock stepped back 19 minutes", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); vi.restoreAllMocks(); resetFirstPageGate(); });
  const clock = { skewMs: 0 };

  it("the next poll is armed within the first step, not the step plus the clock's", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);           // the 15 s step jitters to 12 s
    const armed: Array<{ ms: number; at: number }> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === "number") armed.push({ ms, at: performance.now() });
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof setTimeout);
    const inbox: Array<[number, Msg]> = [[1, ordinary("old-1")], [2, liar("2")], [3, liar("3")], [4, ordinary("behind")]];
    const s = server(inbox);
    const { cycle, events } = await boot(rig(s), clock, cleanups);
    for (let i = 0; i < 4 && !events.some((e) => e.event === "mailbox_redial_after_set_aside"); i++) {
      clock.skewMs += 20_000; await cycle();
    }
    expect(events.some((e) => e.event === "mailbox_redial_after_set_aside"), "no set-aside armed a floor, so this case proves nothing").toBe(true);
    // The floor's own timer fires 12 s from now on the real clock; the wall clock goes back first.
    clock.skewMs -= STEP_MS;
    const from = performance.now();
    const n0 = events.length;
    const t0 = performance.now();
    while (performance.now() - t0 < 30_000 && !events.slice(n0).some((e) => e.event === "mailbox_redial_deferred" || e.event === "mailbox_reconnected" || e.event === "mailbox_redial_after_set_aside")) {
      await new Promise((r) => realSetTimeout(r, 100));
    }
    await new Promise((r) => realSetTimeout(r, 500));
    const after = armed.filter((a) => a.at >= from).map((a) => a.ms);
    expect(events.slice(n0).length, "the floor's poll never ran, so this case proves nothing").toBeGreaterThan(0);
    expect(after.filter((ms) => ms > STEP_MS - 120_000 && ms < STEP_MS + 120_000), `a poll armed for the clock's step (armed: ${after.join(",")})`).toEqual([]);
  });
});
