import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { messages } from "@trafficflow/db";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { freshDataDir } from "./_datadir.js";
import {
  CREDIT_BURST_MS, INGEST_GAP_TURNS, INGEST_LANE_WEIGHT, SCHEDULED_STORE_METHODS, TURN_EVERY,
  createStoreScheduler, currentStoreLane, inStoreLane, ingestIsRunning, scheduleStoreLanes,
} from "../src/store-lanes.js";

/**
 * The scheduler in front of the one connection, on its own.
 *
 * A fake clock and a fake statement, so every figure here is exact: the property is an ORDER and a
 * SHARE, and measuring either against a real database would put the machine's variance inside an
 * assertion. The product reading — that the share is worth having — belongs to the store-lanes budget case, over the real store.
 */

/** A statement that takes `ms` of the fake clock and records when it ran. */
/**
 * Drains opened by {@link world}, released after each case.
 *
 * Every case below runs INSIDE one, because that is when the scheduler exists: with no mail coming
 * in it is not in the path at all, which is its own case at the end of this file. The condition is
 * the product's own — an `inStoreLane("ingest", …)` that has not returned.
 */
const drains: Array<() => void> = [];
afterEach(() => {
  for (const release of drains.splice(0)) release();
});

/** Open a drain for the rest of the case — the condition the scheduler engages on. */
function openDrain(): void {
  let release!: () => void;
  void inStoreLane("ingest", () => new Promise<void>((r) => { release = r; }));
  drains.push(release);
}

function world(gapTurns: number = INGEST_GAP_TURNS) {
  let now = 0;
  const ran: Array<{ lane: string; at: number }> = [];
  openDrain();
  const s = createStoreScheduler({ ingest: INGEST_LANE_WEIGHT, interactive: 1 }, () => now, CREDIT_BURST_MS, gapTurns);
  const stmt = (lane: "ingest" | "interactive", ms: number): Promise<void> =>
    s.run(lane, async () => {
      ran.push({ lane, at: now });
      await Promise.resolve();
      now += ms;
    });
  return { s, ran, stmt, tick: (): number => now };
}

describe("the store's two lanes share one connection", () => {
  it("costs nothing when only one lane has work", async () => {
    const w = world();
    await w.stmt("interactive", 5);
    await w.stmt("interactive", 5);
    expect(w.ran.map((r) => r.lane)).toEqual(["interactive", "interactive"]);
    expect(w.s.census().admitted).toEqual({ ingest: 0, interactive: 2 });
  });

  /**
   * The share, against demand that never runs out — which is the only way to ask the question.
   *
   * A first version queued 64 statements per lane and drained both: the share came out at exactly
   * 0.5 whatever the weights, because with equal, FINITE work every schedule ends with both lanes
   * having had the same time. Weighting decides who goes FIRST, and that only shows against a lane
   * that always has another statement ready — which is what a poll loop is.
   */
  async function shareUnderReaders(readers: number): Promise<number> {
    const w = world();
    const TOTAL = 300;
    let stop = false;
    /* A BUDGET SHARED BY THE CHAINS ENDS THE MEASUREMENT UNEVENLY: counted per issue, the ingest's
       single chain spent its share first and the last fifty admissions were readers alone, with no
       ingest left to compete — the share read 0.58 where the SEQUENCE was a clean `GrGGrGG…`. So
       every chain runs until the scheduler has admitted TOTAL between them. */
    const feed = async (lane: "ingest" | "interactive"): Promise<void> => {
      while (!stop) {
        await w.stmt(lane, 1);
        const c = w.s.census();
        if (c.admitted.ingest + c.admitted.interactive >= TOTAL) stop = true;
      }
    };
    await Promise.all([
      feed("ingest"),
      ...Array.from({ length: readers }, () => feed("interactive")),
    ]);
    const c = w.s.census();
    return c.storeMs.ingest / (c.storeMs.ingest + c.storeMs.interactive);
  }

  it("gives the ingest its weighted share against a fleet of readers, not one turn in nine", async () => {
    // Weighted {@link INGEST_LANE_WEIGHT}:1, so the ingest is owed two thirds of the connection.
    // FIFO gives it one admission in nine; this is the whole difference the file exists for.
    expect(await shareUnderReaders(8)).toBeGreaterThan(0.6);
  });

  it("gives it the SAME share whether one window polls or eight", async () => {
    // The property that matters on a desktop: the lane is the unit, so opening more windows does
    // not take more of the connection away from the mail. FIFO's share would be 1/2 against one
    // reader and 1/9 against eight.
    const one = await shareUnderReaders(1);
    const eight = await shareUnderReaders(8);
    expect(Math.abs(one - eight)).toBeLessThan(0.05);
  });

  /**
   * THE INGEST AS THE PRODUCT RUNS IT: one statement deep, and absent between messages for the
   * check-phase turns its MIME parse settles on — 11.4 a message on the rig, so twelve here.
   * Per message two short reads and the write; eight readers with a short statement always ready.
   * A scheduler that serves whoever is queued gives a reader every one of those turns, and the
   * weight then holds only while both lanes happen to be queued.
   */
  async function shareWithParseGaps(gapTurns: number): Promise<number> {
    const w = world(gapTurns);
    let done = false;
    const turn = (): Promise<void> => new Promise((r) => setImmediate(r));
    const ingest = async (): Promise<void> => {
      for (let m = 0; m < 40; m++) {
        for (let t = 0; t < 12; t++) await turn();
        await w.stmt("ingest", 0.5);
        await w.stmt("ingest", 0.5);
        await w.stmt("ingest", 9);
      }
      done = true;
    };
    const reader = async (): Promise<void> => {
      while (!done) await w.stmt("interactive", 1);
    };
    await Promise.all([ingest(), ...Array.from({ length: 8 }, reader)]);
    const c = w.s.census();
    return c.storeMs.ingest / (c.storeMs.ingest + c.storeMs.interactive);
  }

  it("keeps the ingest's weighted share while it is between two of its own statements", async () => {
    // Held for, the ingest keeps its two thirds (0.66); served-whoever-is-queued (a bound of no
    // turns), the readers take one statement per turn of its parse and the share reads 0.41. And
    // no more than two thirds: the hold waits only while the ingest is BEHIND its weight, so the
    // readers keep their third — waiting regardless would read near 1.
    const held = await shareWithParseGaps(INGEST_GAP_TURNS);
    const unheld = await shareWithParseGaps(0);
    expect(held, `held ${held.toFixed(3)} against ${unheld.toFixed(3)} unheld`).toBeGreaterThan(0.6);
    expect(held, `held ${held.toFixed(3)}: the readers lost their weighted third`).toBeLessThan(0.7);
    expect(unheld, "the schedule no longer leaks the ingest's gaps, so it measures nothing").toBeLessThan(0.5);
  });

  it("waits no more than INGEST_GAP_TURNS turns for an ingest that has gone elsewhere", async () => {
    // A cycle gone to the network is absent for far longer than its parse. The reader, ahead of
    // the ingest on its weighted share, waits out the bound once and is then served every turn.
    const w = world();
    for (let i = 0; i < 20; i++) await w.stmt("interactive", 1);
    await w.stmt("ingest", 9);
    let turns = 0;
    let probing = true;
    const probe = (): void => { setImmediate(() => { if (!probing) return; turns++; probe(); }); };
    probe();
    await w.stmt("interactive", 1);
    const held = turns;
    for (let i = 0; i < 10; i++) await w.stmt("interactive", 1);
    const after = turns - held;
    probing = false;
    expect(held, `the first reader waited ${held} turns`).toBeGreaterThanOrEqual(INGEST_GAP_TURNS - 1);
    expect(held, `the first reader waited ${held} turns`).toBeLessThanOrEqual(INGEST_GAP_TURNS + 2);
    expect(after, `ten more reads took ${after} turns once the bound had run out`).toBeLessThanOrEqual(12);
  });

  it("stops holding the moment the drain closes", async () => {
    // With no mail coming in there is no ingest to wait for: a reader held at the cycle's last
    // statement is served on the turn after the drain ends, not at the end of the bound.
    let now = 0;
    let release!: () => void;
    const drain = inStoreLane("ingest", () => new Promise<void>((r) => { release = r; }));
    const s = createStoreScheduler({ ingest: INGEST_LANE_WEIGHT, interactive: 1 }, () => now);
    const stmt = (lane: "ingest" | "interactive", ms: number): Promise<void> =>
      s.run(lane, async () => { await Promise.resolve(); now += ms; });
    for (let i = 0; i < 20; i++) await stmt("interactive", 1);
    await stmt("ingest", 9);
    let turns = 0;
    let probing = true;
    const probe = (): void => { setImmediate(() => { if (!probing) return; turns++; probe(); }); };
    probe();
    const read = stmt("interactive", 1).then(() => turns);
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    const closedAt = turns;
    release();
    await drain;
    const servedAt = await read;
    probing = false;
    expect(closedAt, "the reader was not held before the drain closed, so this asks nothing").toBeLessThan(servedAt);
    expect(servedAt - closedAt, `served ${servedAt - closedAt} turns after the drain closed`).toBeLessThanOrEqual(2);
  });

  it("never holds the ingest for itself", async () => {
    // The wait is for an ABSENT ingest: queued alone behind a window that is ahead of it on the
    // weight, the ingest runs on the next turn, statement after statement.
    const w = world();
    for (let i = 0; i < 20; i++) await w.stmt("interactive", 1);
    let turns = 0;
    let probing = true;
    const probe = (): void => { setImmediate(() => { if (!probing) return; turns++; probe(); }); };
    probe();
    for (let i = 0; i < 10; i++) await w.stmt("ingest", 1);
    probing = false;
    expect(turns, `ten ingest statements alone took ${turns} turns`).toBeLessThanOrEqual(12);
  });

  it("does not hold a reader that is behind its own share", async () => {
    // The hold is the weight across the ingest's gaps, not a priority: a reader owed its third is
    // served on the next turn even though the ingest has only just returned.
    const w = world();
    for (let i = 0; i < 20; i++) await w.stmt("ingest", 9);
    let turns = 0;
    let probing = true;
    const probe = (): void => { setImmediate(() => { if (!probing) return; turns++; probe(); }); };
    probe();
    await w.stmt("interactive", 1);
    probing = false;
    expect(turns, `a reader behind its share waited ${turns} turns for the ingest`).toBeLessThanOrEqual(2);
  });

  it("interleaves the two lanes rather than draining one", async () => {
    const w = world();
    const pending = [
      w.stmt("interactive", 1), w.stmt("interactive", 1), w.stmt("interactive", 1),
      w.stmt("interactive", 1), w.stmt("interactive", 1), w.stmt("interactive", 1),
      w.stmt("ingest", 1), w.stmt("ingest", 1), w.stmt("ingest", 1),
    ];
    await Promise.all(pending);
    const order = w.ran.map((r) => r.lane).join(",");
    // The first statement is whoever arrived first; from the second on, the ingest may not wait
    // for the whole interactive queue. Six readers ahead of it, and it still runs within three.
    expect(order.split(",").indexOf("ingest")).toBeLessThanOrEqual(2);
  });

  it("caps what an idle lane may claim when it comes back, instead of banking it", async () => {
    const w = world();
    // The interactive lane works alone for 500 ms of store time while the mailbox is quiet.
    for (let i = 0; i < 50; i++) await w.stmt("interactive", 10);
    const before = w.ran.length;
    // Then mail arrives with a backlog, and the window keeps reading.
    let stop = false;
    const feed = async (lane: "ingest" | "interactive"): Promise<void> => {
      while (!stop) {
        await w.stmt(lane, 10);
        if (w.ran.length - before >= 40) stop = true;
      }
    };
    await Promise.all([feed("ingest"), feed("interactive")]);
    const after = w.ran.slice(before, before + 40).map((r) => r.lane);
    /**
     * Uncapped, the ingest arrives 500 ms in credit and runs a long burst of statements before the
     * window gets one — this file's own defect pointed the other way. {@link CREDIT_BURST_MS}
     * bounds the burst at 100 ms of store time (twenty statements at this weight and cost), after
     * which the ordinary 2:1 applies, so a quarter of the first forty are the window's.
     */
    expect(after.filter((l) => l === "interactive").length).toBeGreaterThanOrEqual(5);
    // …and the burst is REAL: the mail that has been waiting is served first, not fairly.
    expect(after.slice(0, 5).every((l) => l === "ingest")).toBe(true);
  });

  it("a statement issued from inside an admission does not queue behind itself", async () => {
    const s = createStoreScheduler();
    const out = await s.run("ingest", async () => s.run("ingest", async () => "through"));
    expect(out).toBe("through");
  });

  it("names the lane a statement belongs to, and unnamed work is interactive", async () => {
    expect(currentStoreLane()).toBe("interactive");
    expect(await inStoreLane("ingest", async () => currentStoreLane())).toBe("ingest");
  });

  it("puts the scheduler in front of every method that reaches the connection", async () => {
    openDrain();
    const seen: string[] = [];
    const client = {
      async query(q: string) { seen.push(`query:${q}:${currentStoreLane()}`); return q; },
      async exec(q: string) { seen.push(`exec:${q}`); return q; },
      async transaction(fn: () => Promise<string>) { seen.push("transaction"); return fn(); },
    };
    const s = createStoreScheduler();
    scheduleStoreLanes(client as never, s);
    await inStoreLane("ingest", async () => {
      await (client as { query(q: string): Promise<string> }).query("select 1");
    });
    await (client as { exec(q: string): Promise<string> }).exec("analyze");
    await (client as { transaction(fn: () => Promise<string>): Promise<string> }).transaction(async () => "committed");
    expect(seen).toEqual(["query:select 1:ingest", "exec:analyze", "transaction"]);
    expect(s.census().admitted).toEqual({ ingest: 1, interactive: 2 });
  });
});

/**
 * …and the same scheduler in front of the store the product actually opens.
 *
 * The cases above are exact because their clock and their statement are fakes. This one asks the
 * question they cannot: that `openLocalDb` puts the scheduler in front of the REAL handle, that the
 * three method names it patches are the three PGlite runs a statement through, and that a lane set
 * six calls up is the lane the census attributes the statement to.
 */
describe("the store the product opens is behind the scheduler", () => {
  const opens: OpenLocalDb[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const o of opens.splice(0)) await o.close().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("attributes a drizzle statement to the lane its caller named", async () => {
    openDrain();
    const dir = await freshDataDir("ohmail-store-lanes-");
    dirs.push(dir);
    const opened = await openLocalDb(dir);
    opens.push(opened);

    const before = opened.laneCensus();
    expect(before, "the desktop store answered no census, so nothing schedules it").not.toBeNull();

    await inStoreLane("ingest", async () => {
      await opened.db.select({ id: messages.id }).from(messages).limit(1);
    });
    await opened.db.select({ id: messages.id }).from(messages).limit(1);

    const after = opened.laneCensus()!;
    expect(after.admitted.ingest - before!.admitted.ingest,
      "the cycle's read was not admitted in the ingest lane").toBeGreaterThanOrEqual(1);
    expect(after.admitted.interactive - before!.admitted.interactive,
      "an unnamed read was not admitted in the interactive lane").toBeGreaterThanOrEqual(1);
    expect(after.storeMs.ingest + after.storeMs.interactive,
      "no store time was accounted at all").toBeGreaterThan(0);
  });

  /**
   * ── THE DRAIN'S TRANSACTION HANDS THE LOOP BACK INSIDE ITSELF ────────────────────────────────
   *
   * A transaction's statements go through its own handle, not the scheduler, and PGlite answers
   * them in microtasks: a long one held every timer and request until it committed. Counted by a
   * `setImmediate` loop across one ingest transaction of three TURN_EVERYs, beside an interactive
   * one of the same length, which keeps its old shape — a read's own transaction is not held open.
   */
  it("takes a turn every TURN_EVERY statements inside an ingest transaction, and not in a read's", async () => {
    const dir = await freshDataDir("ohmail-store-lanes-tx-");
    dirs.push(dir);
    const opened = await openLocalDb(dir);
    opens.push(opened);
    const turnsAcross = async (lane: "ingest" | "interactive"): Promise<number> => {
      let turns = 0;
      let on = true;
      const spin = (): void => { if (on) { turns += 1; setImmediate(spin); } };
      let before = 0;
      const body = () => opened.db.transaction(async (tx) => {
        before = turns;
        for (let i = 0; i < 3 * TURN_EVERY; i += 1) await tx.execute("select 1");
        return turns - before;
      });
      setImmediate(spin);
      const n = lane === "ingest" ? await inStoreLane("ingest", body) : await body();
      on = false;
      return n;
    };
    expect(await turnsAcross("ingest"), "the loop never turned inside the drain's transaction")
      .toBeGreaterThanOrEqual(2);
    expect(await turnsAcross("interactive"), "a read's own transaction was held open across turns")
      .toBe(0);
  });

  it("patches every method PGlite runs a statement through", async () => {
    // The CONTRACT half of `SCHEDULED_STORE_METHODS`: a future PGlite that grew a fourth way to run
    // a statement would run it outside the scheduler, and the only place that can be noticed is
    // here, against the class the product opens.
    const onThePrototype = ["query", "exec", "transaction"].filter(
      (m) => typeof (PGlite.prototype as unknown as Record<string, unknown>)[m] === "function",
    );
    expect(SCHEDULED_STORE_METHODS.filter((m) => onThePrototype.includes(m)))
      .toEqual(onThePrototype);
  });
});

/**
 * The liveness bound, against the real clock — the one property a fake clock cannot answer.
 *
 * `TURN_EVERY` says no more than eight statements run without a turn of the event loop. It is
 * measured here the way the defect was measured in the product: a probe armed on `setImmediate`,
 * which is the phase a stream's own callbacks settle in.
 */
describe("the event loop gets a turn even while one lane runs alone", () => {
  it("no more than TURN_EVERY statements run between two turns", async () => {
    openDrain();
    const s = createStoreScheduler();
    let turns = 0;
    let probing = true;
    const probe = (): void => {
      setImmediate(() => {
        if (!probing) return;
        turns++;
        probe();
      });
    };
    probe();
    // ONE lane only, which is the case the bound is for: with both lanes in use every admission
    // takes the turn anyway (see SHARED_WINDOW).
    const N = 200;
    for (let i = 0; i < N; i++) await s.run("interactive", async () => undefined);
    probing = false;
    expect(turns, `${N} statements ran with ${turns} turns of the loop between them`)
      .toBeGreaterThanOrEqual(Math.floor(N / TURN_EVERY) - 1);
  });
});

describe("with no mail coming in the scheduler is not in the path", () => {
  it("passes a statement straight through — no admission, no census entry", async () => {
    const s = createStoreScheduler();
    expect(ingestIsRunning(), "a drain is open, so this case measures the wrong thing").toBe(false);
    const order: string[] = [];
    await Promise.all([
      s.run("interactive", async () => { order.push("a"); }),
      s.run("interactive", async () => { order.push("b"); }),
    ]);
    // Straight through: both started before either could have been admitted, and the scheduler
    // counted neither. With the gate removed the second waits for the first and both are admitted.
    expect(order).toEqual(["a", "b"]);
    expect(s.census().admitted).toEqual({ ingest: 0, interactive: 0 });
  });

  it("…and engages the moment a drain opens", async () => {
    const s = createStoreScheduler();
    let release!: () => void;
    const drain = inStoreLane("ingest", () => new Promise<void>((r) => { release = r; }));
    expect(ingestIsRunning()).toBe(true);
    await s.run("interactive", async () => undefined);
    expect(s.census().admitted.interactive).toBe(1);
    release();
    await drain;
    expect(ingestIsRunning()).toBe(false);
  });
});
