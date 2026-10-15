/**
 * AN OPEN PHONE KEEPS DRAINING (`src/net/drain-cadence.ts`) — driven through the composition the app
 * runs: the real engine from `bootEngine` over the loopback mail server, the connection layer's
 * `SyncRunner`, and the cadence on a hand-turned clock and a fake lifecycle. The defect: after the
 * adoption's one drain nothing drained again until a press, so mail the server listed a minute later
 * stayed absent on an open phone. Watched RED: the base composition (first drain only) leaves the
 * arrival absent; dropping the re-arm after a settle fails the second-arrival case.
 */
import { afterEach, describe, expect, it } from "vitest";
import { classifyWindowSyncFailure } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { SyncRunner, drainLine } from "../src/net/drain";
import {
  DRAIN_BACKOFF_CAP_MS, FOREGROUND_DRAIN_MS, keepDraining, nextDrainDelay, type AppLifecycle, type CadenceTimers,
} from "../src/net/drain-cadence";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: () => "00000000-0000-4000-8000-000000000000",
};

/** A clock the test turns: nothing fires until {@link advance} or {@link fireNext}. */
function handClock() {
  let seq = 0;
  const due = new Map<number, { ms: number; fn: () => void }>();
  const timers: CadenceTimers = {
    set: (fn, ms) => { seq += 1; due.set(seq, { ms, fn }); return seq; },
    clear: (handle) => { due.delete(handle as number); },
  };
  return {
    timers,
    pending: (): number[] => [...due.values()].map((d) => d.ms),
    /** Turn the clock by `ms`: fire every timer due within it, answering how many fired. */
    advance: (ms: number): number => {
      const hit = [...due.entries()].filter(([, d]) => d.ms <= ms);
      for (const [id, d] of hit) { due.delete(id); d.fn(); }
      return hit.length;
    },
    fireNext: (): number => {
      const first = [...due.entries()][0];
      if (first === undefined) throw new Error("no timer armed");
      due.delete(first[0]);
      first[1].fn();
      return first[1].ms;
    },
  };
}

/** React Native's `AppState`, as a value the test moves. */
function lifecycle(initial: string) {
  let status = initial;
  const listeners = new Set<(s: string) => void>();
  const source: AppLifecycle = {
    now: () => status,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
  return { source, move: (next: string) => { status = next; for (const l of listeners) l(next); } };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

/** A paired phone after its adoption: the first drain settled, the runner and its lines in hand. */
async function pairedPhone() {
  const fake = mailServer();
  fake.addMessage(dto("m-old", { date: new Date(Date.now() - 60_000).toISOString() }));
  const origin = await listen(fake.server);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  cleanups.push(() => { boot.store.close(); fake.server.close(); });
  await boot.verifyIdentity();
  const lines: string[] = [];
  const runner = new SyncRunner({
    syncing: () => undefined,
    error: () => undefined,
    settled: (o) => lines.push(drainLine(o, "paired", classifyWindowSyncFailure)),
  });
  await runner.run(boot.engine, true);
  const has = (id: string): boolean => boot.engine.read().get("message", id) !== undefined;
  const syncs = (): number => fake.seen.filter((r) => r.method === "GET" && r.url.startsWith("/sync")).length;
  const round = (): Promise<number> => runner.request(boot.engine).then(() => runner.failures());
  /** Let a fired round reach the wire, land, and re-arm. */
  const landed = async (): Promise<void> => { await settle(); await runner.inFlight(); await settle(); await settle(); };
  return { fake, boot, runner, lines, has, syncs, round, landed };
}

const arrival = (id: string) => dto(id, { date: new Date().toISOString() });

describe("an open, foreground, paired phone keeps draining", () => {
  it("fetches a server-side arrival within the interval, untouched — and the next one after it", async () => {
    const phone = await pairedPhone();
    const clock = handClock();
    const app = lifecycle("active");
    cleanups.push(keepDraining({ round: phone.round, lifecycle: app.source, timers: clock.timers }));

    phone.fake.addMessage(arrival("m-new"));
    expect(phone.has("m-new"), "the arrival was in the mirror before any round").toBe(false);
    clock.advance(FOREGROUND_DRAIN_MS);
    await phone.landed();
    expect(phone.has("m-new"), "mail the server listed was not fetched within the interval").toBe(true);

    // AND AGAIN: the cadence re-arms after every settle, not once.
    phone.fake.addMessage(arrival("m-newer"));
    clock.advance(FOREGROUND_DRAIN_MS);
    await phone.landed();
    expect(phone.has("m-newer"), "the cadence drained once and stopped").toBe(true);
    expect(clock.pending(), "the next round is not on the cadence").toEqual([FOREGROUND_DRAIN_MS]);
    expect(phone.lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([
      { service: "sync", event: "cloud_pull_applied", door: "paired", first: true },
      { service: "sync", event: "cloud_pull_applied", door: "paired", first: false },
      { service: "sync", event: "cloud_pull_applied", door: "paired", first: false },
    ]);
  });

  it("the base composition — the adoption's drain alone — never fetches it (the defect, as a control)", async () => {
    const phone = await pairedPhone();
    phone.fake.addMessage(arrival("m-new"));
    const before = phone.syncs();
    // Nothing in the harness but the cadence asks the server, so without it nothing moves.
    await new Promise((r) => setTimeout(r, 50));
    expect(phone.syncs()).toBe(before);
    expect(phone.has("m-new")).toBe(false);
  });
});

describe("no timer runs in the background; the foreground drains at once", () => {
  it("backgrounded before the cadence starts: nothing armed, nothing asked", async () => {
    const phone = await pairedPhone();
    const clock = handClock();
    const app = lifecycle("background");
    cleanups.push(keepDraining({ round: phone.round, lifecycle: app.source, timers: clock.timers }));
    expect(clock.pending(), "a backgrounded app held a drain timer").toEqual([]);
    app.move("inactive");
    expect(clock.pending()).toEqual([]);
  });

  it("leaving the foreground clears the timer; coming back drains now and re-arms", async () => {
    const phone = await pairedPhone();
    const clock = handClock();
    const app = lifecycle("active");
    cleanups.push(keepDraining({ round: phone.round, lifecycle: app.source, timers: clock.timers }));
    expect(clock.pending()).toEqual([FOREGROUND_DRAIN_MS]);

    app.move("background");
    expect(clock.pending(), "the drain timer outlived the foreground").toEqual([]);
    const asked = phone.syncs();
    phone.fake.addMessage(arrival("m-away"));
    await settle();
    expect(phone.syncs(), "a backgrounded app asked the server").toBe(asked);

    app.move("active");
    expect(phone.runner.inFlight(), "the return to the foreground did not drain at once").not.toBeNull();
    await phone.landed();
    expect(phone.has("m-away")).toBe(true);
    expect(clock.pending()).toEqual([FOREGROUND_DRAIN_MS]);
  });

  it("stop ends it: no timer, and a later return to the foreground drains nothing", async () => {
    const phone = await pairedPhone();
    const clock = handClock();
    const app = lifecycle("active");
    const stop = keepDraining({ round: phone.round, lifecycle: app.source, timers: clock.timers });
    stop();
    expect(clock.pending()).toEqual([]);
    app.move("background");
    app.move("active");
    expect(phone.runner.inFlight()).toBeNull();
  });
});

describe("a failing round backs off and says why, content-free", () => {
  it("the ladder: the cadence, then doubling per failure to the cap", () => {
    expect(nextDrainDelay(0)).toBe(FOREGROUND_DRAIN_MS);
    expect(nextDrainDelay(1)).toBe(FOREGROUND_DRAIN_MS);
    expect(nextDrainDelay(2)).toBe(2 * FOREGROUND_DRAIN_MS);
    expect(nextDrainDelay(3)).toBe(4 * FOREGROUND_DRAIN_MS);
    expect(nextDrainDelay(4)).toBe(DRAIN_BACKOFF_CAP_MS);
    expect(nextDrainDelay(40)).toBe(DRAIN_BACKOFF_CAP_MS);
  });

  it("a refused round writes cloud_pull_failed with the engine's closed record, then waits longer", async () => {
    const phone = await pairedPhone();
    const clock = handClock();
    const app = lifecycle("active");
    cleanups.push(keepDraining({ round: phone.round, lifecycle: app.source, timers: clock.timers }));
    for (let i = 0; i < 4; i++) phone.fake.failNextStatus("GET", "/sync", 503);
    clock.fireNext();
    await phone.landed();
    expect(phone.runner.failures()).toBeGreaterThanOrEqual(1);
    const failed = JSON.parse(phone.lines.at(-1)!) as Record<string, unknown>;
    expect(failed).toMatchObject({ service: "sync", event: "cloud_pull_failed", door: "paired", first: false });
    // The whole line is closed fields: no message text, no id, no address can ride it.
    expect(Object.keys(failed).every((k) =>
      ["service", "event", "door", "first", "attempt", "reason", "errorClass", "status", "code"].includes(k))).toBe(true);
    expect(clock.pending()).toEqual([nextDrainDelay(phone.runner.failures())]);
  });
});
