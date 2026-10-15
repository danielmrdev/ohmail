/**
 * THE SYNC ROUND'S TWO CONTRACTS (`src/net/drain.ts`), held against a deferred fake engine so
 * the exact interleavings are driven rather than hoped for:
 *
 *  · **honest settle** — the promise a pull spinner renders on resolves when the ENGINE's
 *    round settles, never before (a settle-on-timer mutant goes red on the first suite);
 *  · **quiet refusal** — a failed round resolves (never rejects), captures the one failure
 *    sentence, and re-hydrates so the torn-flush window closes before any retry.
 *
 * This is the seam pull-to-refresh rings (`state/pull.ts` → `connection.syncNow` →
 * `SyncRunner.request`) — the same doorbell the wake channel and the Servers screen press.
 */
import { describe, expect, it } from "vitest";
import { sayArg, type RefusalArg } from "../src/refusal";
import { classifyWindowSyncFailure } from "@ohmail/client-engine";
import { SyncRunner, drainLine, type DrainEngine, type RoundOutcome } from "../src/net/drain";

/** A deferred engine: every call hands the test its resolver. */
function fakeEngine() {
  const calls: string[] = [];
  const pending: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  const defer = (name: string): Promise<void> => {
    calls.push(name);
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  };
  const engine: DrainEngine = {
    start: () => defer("start"),
    syncOnce: () => defer("syncOnce"),
    hydrate: () => defer("hydrate"),
  };
  return { engine, calls, pending };
}

function recorder() {
  const syncing: boolean[] = [];
  const errors: (RefusalArg | null)[] = [];
  return {
    runner: new SyncRunner({ syncing: (on) => syncing.push(on), error: (e) => errors.push(e) }),
    syncing,
    errors,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("honest settle: the round's promise IS the engine's round", () => {
  it("stays unsettled until the engine resolves — never a timer", async () => {
    const { engine, pending } = fakeEngine();
    const { runner } = recorder();
    let settled = false;
    const round = runner.request(engine).then(() => {
      settled = true;
    });
    // Give any early-resolve mutant every chance to show itself — microtasks AND real time.
    await tick();
    await tick();
    await new Promise((r) => setTimeout(r, 25));
    // THE assertion a settle-on-timer (or resolve-on-dispatch) mutant turns red: the engine
    // has not answered, so neither may the round. (The in-flight identity suite below closes
    // the rest of the family: whatever `run` returns must BE the round `inFlight()` clears.)
    expect(settled).toBe(false);
    pending[0]!.resolve();
    await round;
    expect(settled).toBe(true);
  });

  it("a pull during a round JOINS it — one engine round, both settle together", async () => {
    const { engine, calls, pending } = fakeEngine();
    const { runner, syncing } = recorder();
    const first = runner.run(engine, false);
    const second = runner.request(engine); // the pull, mid-round
    await tick(); // the round registers first, invokes the engine on the next microtask
    expect(calls).toEqual(["syncOnce"]); // coalesced: no second round was started
    let firstDone = false;
    let secondDone = false;
    void first.then(() => (firstDone = true));
    void second.then(() => (secondDone = true));
    await tick();
    expect(firstDone).toBe(false);
    expect(secondDone).toBe(false);
    pending[0]!.resolve();
    await Promise.all([first, second]);
    expect(firstDone).toBe(true);
    expect(secondDone).toBe(true);
    // The busy flag rose once and fell once — one round, however many callers.
    expect(syncing).toEqual([true, false]);
  });

  it("a session's FIRST round is engine.start(); every later one is syncOnce()", async () => {
    const { engine, calls, pending } = fakeEngine();
    const { runner } = recorder();
    const first = runner.run(engine, true);
    await tick();
    expect(calls).toEqual(["start"]);
    pending[0]!.resolve();
    await first;
    const later = runner.request(engine);
    await tick();
    expect(calls).toEqual(["start", "syncOnce"]);
    pending[1]!.resolve();
    await later;
  });
});

describe("quiet refusal: a failure settles, says its one sentence, and re-hydrates", () => {
  it("captures the sentence, runs the re-hydrate, resolves — never rejects", async () => {
    const { engine, calls, pending } = fakeEngine();
    const { runner, syncing, errors } = recorder();
    const round = runner.run(engine, false);
    await tick();
    pending[0]!.reject(new Error("the server answered 503"));
    await tick();
    await tick();
    // The torn-flush rule: the failed round re-hydrates before it settles.
    expect(calls).toEqual(["syncOnce", "hydrate"]);
    pending[1]!.resolve();
    await round; // resolves — the failure is a state, not a throw into the caller
    expect(errors[0]).toBeNull(); // cleared at the round's start
    expect(errors[1]).toMatch(/503/);
    expect(syncing).toEqual([true, false]);
  });

  it("even a hydrate that ALSO fails cannot make the round reject", async () => {
    const { engine, pending } = fakeEngine();
    const { runner, errors } = recorder();
    const round = runner.run(engine, false);
    await tick();
    pending[0]!.reject(new Error("network down"));
    await tick();
    await tick();
    pending[1]!.reject(new Error("storage refused"));
    await round;
    expect(errors[1]).toMatch(/network down/);
  });

  it("the next round clears the standing sentence — a retry starts clean", async () => {
    const { engine, pending } = fakeEngine();
    const { runner, errors } = recorder();
    const failed = runner.run(engine, false);
    await tick();
    pending[0]!.reject(new Error("no route"));
    await tick();
    await tick();
    pending[1]!.resolve(); // the re-hydrate
    await failed;
    const retry = runner.run(engine, false);
    expect(errors.at(-1)).toBeNull(); // the retry's own clear
    await tick();
    pending[2]!.resolve();
    await retry;
  });
});

describe("a superseded round stays silent — the live round owns the busy flag", () => {
  it("an old session's landing must not spend the falling edge the new round's completion needs", async () => {
    // A profile switch can start a new round while the old one is still in the air (teardown
    // does not await it). The busy flag FALLING is the signal the world layer re-derives on
    // (the settled stamp, the retry flush, the folders re-read) — so it must fall exactly
    // when the LIVE round lands. A mutant that lets the stale round report goes red here:
    // its false would fire mid-flight, the live round's own completion would be a no-op
    // state write, and a just-synced empty mailbox would keep its skeleton.
    const oldEngine = fakeEngine();
    const newEngine = fakeEngine();
    const { runner, syncing, errors } = recorder();
    const oldRound = runner.run(oldEngine.engine, false);
    const newRound = runner.run(newEngine.engine, true); // the switch's first drain
    await tick();
    expect(syncing).toEqual([true, true]);
    // The OLD round lands first — and reports nothing: it is no longer the round of record.
    oldEngine.pending[0]!.reject(new Error("old session died mid-air"));
    await tick();
    await tick();
    oldEngine.pending[1]!.resolve(); // its re-hydrate
    await oldRound;
    expect(syncing).toEqual([true, true]); // no falling edge yet
    expect(errors.filter((e) => e !== null)).toEqual([]); // and no stale failure sentence
    // The LIVE round lands: THE falling edge.
    newEngine.pending[0]!.resolve();
    await newRound;
    expect(syncing).toEqual([true, true, false]);
    expect(runner.inFlight()).toBeNull();
  });
});

describe("disown: the leaving session's round no longer speaks for the UI", () => {
  it("drops the busy flag now, clears the sentence, and silences the round's own landing", async () => {
    const { engine, pending } = fakeEngine();
    const { runner, syncing, errors } = recorder();
    const round = runner.run(engine, false);
    await tick();
    // Teardown's order: capture the round for the close-wait, THEN disown.
    const held = runner.inFlight();
    runner.disown();
    expect(held).toBe(round);
    expect(runner.inFlight()).toBeNull();
    expect(syncing).toEqual([true, false]); // the flag fell with the disown, not the landing
    expect(errors.at(-1)).toBeNull();
    // The disowned round lands — a FAILURE, even — and publishes nothing.
    pending[0]!.reject(new Error("the dead session's server refused"));
    await tick();
    await tick();
    pending[1]!.resolve(); // its re-hydrate
    await round;
    expect(syncing).toEqual([true, false]); // no second falling edge
    expect(errors.filter((e) => e !== null)).toEqual([]); // the sentence never landed
  });
});

describe("an engine that throws SYNCHRONOUSLY is an ordinary failed round", () => {
  it("reports the sentence, drops the busy flag, resolves — registration precedes invocation", async () => {
    // The round takes the record BEFORE any engine code runs (the registration yield), so a
    // synchronous throw cannot slip past the record gates unreported — and a synchronously
    // throwing hydrate stays inside the round instead of rejecting it.
    const engine: DrainEngine = {
      start: () => { throw new Error("sync-thrown start"); },
      syncOnce: () => { throw new Error("sync-thrown syncOnce"); },
      hydrate: () => { throw new Error("sync-thrown hydrate"); },
    };
    const { runner, syncing, errors } = recorder();
    await runner.run(engine, false); // resolves — never rejects
    expect(errors[1]).toMatch(/sync-thrown syncOnce/);
    expect(syncing).toEqual([true, false]);
    expect(runner.inFlight()).toBeNull();
  });

  it("even OVER an in-flight round: the throw is this round's failure, not a silenced orphan", async () => {
    // The registration yield's load-bearing case. Without it, a synchronous throw runs the
    // failure report BEFORE the box is filled and the record still names the OLD round — the
    // sentence is suppressed and the mutant is invisible on a quiet runner. A switch's first
    // drain against a broken engine is exactly this shape.
    const flying = fakeEngine();
    const broken: DrainEngine = {
      start: () => { throw new Error("sync-thrown start"); },
      syncOnce: () => { throw new Error("sync-thrown syncOnce"); },
      hydrate: () => Promise.resolve(),
    };
    const { runner, errors } = recorder();
    void runner.run(flying.engine, false); // the old session's round, still in the air
    await tick();
    await runner.run(broken, true); // the switch's first drain — throws synchronously
    expect(errors.filter((e) => e !== null)).toEqual(["Error: sync-thrown start"]);
    expect(runner.inFlight()).toBeNull(); // the broken round took and released the record
  });
});

describe("the in-flight handle (teardown's await)", () => {
  it("names the round while it flies and clears when it lands", async () => {
    const { engine, pending } = fakeEngine();
    const { runner } = recorder();
    expect(runner.inFlight()).toBeNull();
    const round = runner.run(engine, false);
    expect(runner.inFlight()).toBe(round);
    await tick();
    pending[0]!.resolve();
    await round;
    expect(runner.inFlight()).toBeNull();
  });
});

/**
 * WHAT THE CADENCE AND THE DRAIN LINE READ (`net/drain-cadence.ts`, `drainLine`): the consecutive
 * failures of record, and one settle per round of record. Watched RED: a counter that never resets
 * fails the success case; a settle written for a superseded round fails the silence case.
 */
describe("failures and the settle: one per round of record", () => {
  function settledRecorder() {
    const outcomes: RoundOutcome[] = [];
    const runner = new SyncRunner({ syncing: () => undefined, error: () => undefined, settled: (o) => outcomes.push(o) });
    return { runner, outcomes };
  }

  it("counts consecutive failures and resets on the next success", async () => {
    const { engine, pending } = fakeEngine();
    const { runner, outcomes } = settledRecorder();
    for (let i = 0; i < 2; i++) {
      const round = runner.request(engine);
      await tick();
      pending.shift()!.reject(Object.assign(new Error("secret subject line"), { status: 503 }));
      await tick();
      pending.shift()!.resolve(); // the re-hydrate
      await round;
    }
    expect(runner.failures()).toBe(2);
    const ok = runner.request(engine);
    await tick();
    pending.shift()!.resolve();
    await ok;
    expect(runner.failures(), "a success did not reset the backoff").toBe(0);
    expect(outcomes.map((o) => o.ok)).toEqual([false, false, true]);
    expect(outcomes.map((o) => (o.ok ? 0 : o.failures))).toEqual([1, 2, 0]);
  });

  it("a superseded or disowned round settles nothing", async () => {
    const oldEngine = fakeEngine();
    const newEngine = fakeEngine();
    const { runner, outcomes } = settledRecorder();
    const oldRound = runner.run(oldEngine.engine, false);
    const newRound = runner.run(newEngine.engine, true);
    await tick();
    oldEngine.pending[0]!.resolve();
    await oldRound;
    expect(outcomes, "the superseded round wrote a drain line").toEqual([]);
    runner.disown();
    newEngine.pending[0]!.resolve();
    await newRound;
    expect(outcomes, "the disowned round wrote a drain line").toEqual([]);
    expect(runner.failures()).toBe(0);
  });

  it("the line: the desktop's event names, closed fields, never a message", () => {
    expect(JSON.parse(drainLine({ ok: true, first: true }, "paired", classifyWindowSyncFailure)))
      .toEqual({ service: "sync", event: "cloud_pull_applied", door: "paired", first: true });
    const failed = drainLine(
      { ok: false, first: false, err: Object.assign(new Error("Re: a subject someone wrote"), { status: 503 }), failures: 2 },
      "standalone",
      classifyWindowSyncFailure,
    );
    expect(JSON.parse(failed)).toEqual({
      service: "sync", event: "cloud_pull_failed", door: "standalone", first: false,
      attempt: 2, reason: "http_refusal", errorClass: "Error", status: 503,
    });
    expect(failed).not.toContain("subject");
  });
});
