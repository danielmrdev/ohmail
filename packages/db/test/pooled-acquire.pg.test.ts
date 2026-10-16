import { describe, it, expect, afterEach } from "vitest";
import { sql as raw } from "drizzle-orm";
import { pgTable, integer, text } from "drizzle-orm/pg-core";
import {
  makePooledDb, closePooledDbs, POOLED_ACQUIRE_TIMEOUT_MS, API_MAX_DURATION_MS,
  SESSION_ACQUIRE_TIMEOUT_MS, POOLED_MAX_CONNECTIONS, DbAcquireTimeoutError, isDbAcquireTimeout,
} from "../src/client.js";
import { realPgAvailable, PG_TEST_URL } from "../src/testing.js";

const AVAILABLE = await realPgAvailable();

/**
 * ── THE GATEWAY-TIMEOUT-UNDER-CONCURRENCY FAMILY, AND WHY EVERY CEILING BEFORE THIS ONE WAS BLIND TO IT ───
 *
 * Production served a burst of `FUNCTION_INVOCATION_TIMEOUT` timeouts in twenty minutes, every one at the
 * platform's own ceiling, across twelve unrelated routes at once, on hot instances with
 * `crashed=false`. The row that names the cause is `HEAD /health` at **60 012 ms**: that route's
 * whole database cost is one trivial `select`, so it cannot have been SLOW — it can only have
 * WAITED, and what it waited for is the single connection `makePooledDb` hands out, shared by
 * every concurrent invocation on that warm instance.
 *
 * `pooled-db.pg.test.ts` proves the ceilings for the OTHER half of the family — a statement that
 * runs too long, a lock that never comes. Every one of those bounds the statement AT THE HEAD of
 * the connection. This file is about everybody behind it.
 *
 * ── THE MECHANISM, MEASURED, BECAUSE THE OBVIOUS READING OF IT IS WRONG ───────────────────────
 *
 * `max: 1` does NOT make a second caller queue in the pool. `max_pipeline` defaults to 100, so the
 * driver pipelines up to `max_pipeline` queries onto the one busy socket, where Postgres runs them in
 * order. The first draft of this file asserted a pool queue and went green in the wrong direction:
 * the "waiter" resolved instantly, because a lazily-constructed drizzle query had never been
 * dispatched at all. With the holder genuinely in flight, a `select 1` issued 50 ms behind a
 * `select pg_sleep(2)` had `state` SET, `active` FALSE, and resolved at **+2002 ms**.
 *
 * That is why the ceiling reads `active` and not `state`, and why these tests exist in this shape:
 * a guard written against the pool queue would never have fired in production.
 *
 * These run against the docker Postgres on :5433. PGlite cannot host them at all: it has no
 * connection pool and no pipeline, so the resource being contended does not exist there and every
 * assertion below would pass vacuously.
 */
const URL = PG_TEST_URL;

/** Small enough to keep the suite quick; production uses {@link POOLED_ACQUIRE_TIMEOUT_MS}. */
const ACQUIRE_MS = 400;

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("POOLED_ACQUIRE_TIMEOUT_MS — the value", () => {
  it("leaves the route most of its budget to still answer after the refusal", () => {
    // The whole point of failing fast: a ceiling that consumed the invocation's budget would swap
    // one silent 504 for another. 15 s inside a 60 s invocation leaves 45 s to return the 503.
    expect(POOLED_ACQUIRE_TIMEOUT_MS).toBeLessThan(API_MAX_DURATION_MS);
    expect(API_MAX_DURATION_MS - POOLED_ACQUIRE_TIMEOUT_MS).toBeGreaterThanOrEqual(40_000);
  });

  it("the session doors refuse sooner than a write, and both inside the platform budget", () => {
    // The split this rests on: a caller that gives up at 1.5 s (the edge gate) or retries (the
    // splash, the desktop engine) gains nothing from a 15 s wait, and a write keeps its 15 s.
    expect(SESSION_ACQUIRE_TIMEOUT_MS).toBeLessThan(POOLED_ACQUIRE_TIMEOUT_MS);
    expect(SESSION_ACQUIRE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(API_MAX_DURATION_MS - SESSION_ACQUIRE_TIMEOUT_MS).toBeGreaterThanOrEqual(40_000);
  });

  it("an instance holds more than one connection — Fluid serves concurrent requests from one", () => {
    // A value of 1 is the shape that queued every second request behind the first. The width
    // itself is asserted behaviourally below; this catches the constant being put back.
    expect(POOLED_MAX_CONNECTIONS).toBeGreaterThan(1);
    expect(Number.isSafeInteger(POOLED_MAX_CONNECTIONS)).toBe(true);
  });

  it("recognises the error by NAME, because the API may not import the class", () => {
    // `packages/api/src/middleware.ts` matches on `name`: it sits inside the desktop engine's
    // import closure and may not reach `@trafficflow/db/cloud` (the closure rule at the top of
    // `packages/db/src/index.ts`). This pins the string that contract depends on.
    expect(new DbAcquireTimeoutError(1).name).toBe("DbAcquireTimeoutError");
    expect(isDbAcquireTimeout(new DbAcquireTimeoutError(1))).toBe(true);
    // A structural twin must satisfy it too — that IS the contract, not a leniency: the API's
    // copy of this check has no access to the class.
    expect(isDbAcquireTimeout({ name: "DbAcquireTimeoutError" })).toBe(true);
    expect(isDbAcquireTimeout(new Error("something else"))).toBe(false);
  });
});

/**
 * DISPATCH a drizzle query instead of merely constructing one.
 *
 * `db.execute(...)` is LAZY — it runs on first `then`. The first draft of this file bound a
 * "holder" to an undispatched promise, so nothing ever occupied the connection and every waiter
 * resolved instantly: a guard that was green because the scenario it describes had not happened.
 * Attaching a continuation here is what puts the statement on the wire.
 */
function fire<T>(work: PromiseLike<T>): Promise<T> {
  const started = Promise.resolve(work);
  started.catch(() => { /* the test awaits it; this only stops an unhandled rejection */ });
  return started;
}

type Pooled = ReturnType<typeof makePooledDb>;

/** Dial every connection the pool may hold, so each holder below lands on its own. */
async function warmAll(db: Pooled): Promise<void> {
  await Promise.all(Array.from({ length: POOLED_MAX_CONNECTIONS },
    () => db.execute(raw`select pg_sleep(0.05)`)));
}

/**
 * The saturated instance: EVERY connection busy with a long statement, so the next query can only
 * pipeline behind one of them. With one connection a single holder was enough; with
 * {@link POOLED_MAX_CONNECTIONS} a single holder leaves three idle sockets and proves nothing.
 */
async function occupyAll(db: Pooled, seconds: number): Promise<Promise<unknown>[]> {
  await warmAll(db);
  const holders = Array.from({ length: POOLED_MAX_CONNECTIONS },
    () => fire(db.execute(raw`select pg_sleep(${raw.raw(String(seconds))})`)));
  await tick(50);
  return holders;
}

describe.skipIf(!AVAILABLE)("the pooled handle's wait to begin executing", () => {
  afterEach(async () => { await closePooledDbs(); });

  it("THE REGRESSION: a trivial read behind a busy connection is REFUSED, not hung", async () => {
    // The production shape, reproduced. One long statement occupies the instance's only backend;
    // a request that needs nothing but `select 1` is pipelined behind it and cannot start until it
    // finishes. That is the `HEAD /health` row at 60 012 ms: a trivial read that was never slow,
    // only last in line, whose sole exit was the platform killing the invocation.
    const db = makePooledDb(URL, { acquireTimeoutMs: ACQUIRE_MS });

    // Warm first, so every holder takes an OPEN connection synchronously and this measures the
    // wait behind them rather than a dial.
    const holders = await occupyAll(db, 3);

    const started = Date.now();
    const err = await db.execute(raw`select 1 as one`)
      .then(() => null)
      .catch((e: unknown) => e as { name?: string });
    const took = Date.now() - started;

    expect(err, "the blocked read must be refused, not left waiting").not.toBeNull();
    expect(err?.name).toBe("DbAcquireTimeoutError");
    // It gave up at ITS ceiling — not at the holder's 3 s, and nothing like the platform's 60 s.
    expect(took).toBeGreaterThanOrEqual(ACQUIRE_MS - 150);
    expect(took).toBeLessThan(1_500);

    // …and the statements at the heads were untouched by any of it.
    for (const holder of holders) await expect(holder).resolves.toBeDefined();
  }, 60_000);

  it("THE WIDTH: as many concurrent statements as the pool holds all run; the next is refused", async () => {
    // What `max: 1` got wrong on a Fluid instance: a second concurrent request queued behind the
    // first. Every head below needs its own connection or it pipelines, is not `active`, and is
    // refused — so a pool narrowed back to one connection reddens this at the heads, not the tail.
    const db = makePooledDb(URL, { acquireTimeoutMs: ACQUIRE_MS });
    await warmAll(db);

    const heads = Array.from({ length: POOLED_MAX_CONNECTIONS }, () => fire(
      db.execute(raw`select pg_sleep(1.2)`)
        .then(() => "ran", (e: unknown) => (e as { name?: string }).name ?? "unknown"),
    ));
    await tick(50);
    const next = await db.execute(raw`select 1 as one`)
      .then(() => "ran", (e: unknown) => (e as { name?: string }).name ?? "unknown");

    expect(await Promise.all(heads)).toEqual(Array.from({ length: POOLED_MAX_CONNECTIONS }, () => "ran"));
    expect(next, "the statement past the pool's width meets the ceiling").toBe("DbAcquireTimeoutError");
  }, 60_000);

  it("TWELVE UNRELATED READS AT ONCE — all refused fast, none riding to the ceiling", async () => {
    // The incident's actual signature: twelve unrelated routes timing out together on one warm
    // instance, because they share one backend and something long was at the head of it. The
    // count is the incident's, not a round number.
    const db = makePooledDb(URL, { acquireTimeoutMs: ACQUIRE_MS });
    const holders = await occupyAll(db, 3);

    const started = Date.now();
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => db.execute(raw`select 1 as one`)
        .then(() => "resolved")
        .catch((e: unknown) => (e as { name?: string }).name)),
    );
    const took = Date.now() - started;

    expect(outcomes).toEqual(Array.from({ length: 12 }, () => "DbAcquireTimeoutError"));
    // All twelve gave up together, at their own ceiling, while the holders still had ~2.5 s to run.
    expect(took).toBeLessThan(1_500);
    for (const holder of holders) await expect(holder).resolves.toBeDefined();
  }, 60_000);

  it("NO FALSE POSITIVES: fifty concurrent ordinary reads all succeed", async () => {
    // The other side of the trade, and the thing that would make this ceiling a worse bug than
    // the one it fixes. `max: 1` means every concurrent invocation on a warm instance shares one
    // backend, so waiting is the NORMAL mode here, not only the pathological one — a ceiling that
    // could not tell "fifty fast statements ahead of me" from "one 55 s statement ahead of me"
    // would turn ordinary traffic into 503s.
    //
    // Fifty is deliberately more than the twelve the incident showed, and they are pipelined onto
    // the pool's few connections with a sub-second ceiling — an order of magnitude tighter than production's.
    const db = makePooledDb(URL, { acquireTimeoutMs: ACQUIRE_MS });
    await db.execute(raw`select 1`);

    const started = Date.now();
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, (_, i) => db.execute(raw`select ${i} as n`)
        .then(() => "ok")
        .catch((e: unknown) => (e as { name?: string }).name ?? "unknown")),
    );

    expect(new Set(outcomes)).toEqual(new Set(["ok"]));
    expect(Date.now() - started).toBeLessThan(ACQUIRE_MS);
  }, 60_000);

  it("bounds the WAIT and never the statement: a running query outlives the ceiling", async () => {
    // The distinction the whole design rests on. Once the backend is running THIS statement
    // (`active`), the ceiling must do nothing at all — otherwise it is a second, tighter statement
    // timeout wearing the wrong name, and it would kill legitimate work the server's own ceilings
    // exist to bound. A statement allowed 55 s by ROLE_DEFAULT_TIMEOUTS keeps all 55 s of it.
    const db = makePooledDb(URL, { acquireTimeoutMs: ACQUIRE_MS });
    await db.execute(raw`select 1`);

    const started = Date.now();
    await expect(db.execute(raw`select pg_sleep(1.5)`)).resolves.toBeDefined();
    // It ran to completion, well past a ceiling that would have refused it three times over.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
  }, 60_000);

  /**
   * REFUSING DURING A COLD DIAL MUST NOT WEDGE THE POOL — the hazard that decided this ceiling
   * refuses without ever cancelling.
   *
   * The tempting middle position was to cancel only when `state === null`, since the driver's
   * branch for that is a local `queries.remove(query)` with no socket. It is wrong because
   * `state === null` does not mean "in the queue": on a cold or reconnecting pool
   * `index.js` `connect(c, query)` hands the query to the CONNECTION as its `initial` and never
   * queues it. Cancelling it removes nothing, and the ready path then runs `execute(initial)`,
   * which returns at its `if (q.cancelled) return` guard — and returns WITHOUT `onopen`, leaving
   * the connection parked in `connecting` while every later query queues behind it.
   *
   * A ceiling must not be able to do worse than the thing it bounds, so this drives the exact
   * shape: a ceiling short enough to fire DURING the dial, and then the pool must still work.
   * Reinstating the cancel turns this red.
   */
  it("a refusal DURING the initial dial leaves the pool usable", async () => {
    await closePooledDbs();                    // guarantee the next handle dials cold
    // ONE connection, or the handle below would dial a fresh one and never meet the parked one.
    const cold = makePooledDb(URL, { acquireTimeoutMs: 1, max: 1 });

    // THE REFUSAL IS ASSERTED, NOT TOLERATED. The first version of this let the query succeed if
    // the dial beat the timer — which would exercise none of the path it exists to guard and go
    // green even with the wedge reinstated. A guard that can pass without entering the code it
    // names is not a guard (the "Testing bar" invariant). A 1 ms ceiling against a TCP dial plus a Postgres startup
    // handshake is not a close race; if this ever fails, the ceiling needs retuning and saying so
    // loudly is the point.
    const err = await cold.execute(raw`select 1`)
      .then(() => null)
      .catch((e: unknown) => e as { name?: string });
    expect(err, "the refusal must actually happen, or this test proves nothing").not.toBeNull();
    expect(err?.name).toBe("DbAcquireTimeoutError");

    // …and now the assertion that matters: the connection this refused mid-dial must not have been
    // left parked in the pool's `connecting` queue.
    const after = makePooledDb(URL, { acquireTimeoutMs: 5_000 });
    const started = Date.now();
    await expect(after.execute(raw`select 42 as answer`)).resolves.toBeDefined();
    expect(Date.now() - started, "the pool must not be parked in `connecting`").toBeLessThan(4_000);
  }, 60_000);

  it("the connection keeps working after a refusal (the ceiling is not a wedge)", async () => {
    // A ceiling that leaves the handle unusable would trade a twenty-minute incident for a
    // permanent one. The refused caller is refused; nothing else is.
    const db = makePooledDb(URL, { acquireTimeoutMs: ACQUIRE_MS });
    const holders = await occupyAll(db, 1.5);
    await expect(db.execute(raw`select 1`)).rejects.toMatchObject({ name: "DbAcquireTimeoutError" });
    await Promise.all(holders);

    const started = Date.now();
    await expect(db.execute(raw`select 42 as answer`)).resolves.toBeDefined();
    expect(Date.now() - started).toBeLessThan(ACQUIRE_MS);
  }, 60_000);
});

/**
 * THE CHAINED PATH, WHICH IS THE ONE EVERY ORM READ ACTUALLY TAKES.
 *
 * The ceiling wraps the driver's `Query` in a proxy, and a proxy that forgets to re-wrap a
 * chainable method silently hands the RAW query back to the caller — after which the guard is
 * gone and the value returned is subtly the wrong shape. This is the highest-risk part of the
 * change and the tests above do not touch it: `db.execute(sql\`…\`)` has no `fields`, so
 * `drizzle-orm/postgres-js` takes its `client.unsafe(query, params)` branch. **Every query-builder
 * read takes the other branch — `client.unsafe(query, params).values()`** — and then maps the row
 * ARRAYS it gets back through `mapResultRow`. A proxy whose `values()` returned the unproxied
 * query would still resolve here, so the assertions are about the shape and the guard, not merely
 * about not throwing.
 */
const probe = pgTable("tf_acquire_chain_probe", { id: integer("id").primaryKey(), label: text("label") });

describe.skipIf(!AVAILABLE)("the ceiling survives drizzle's row-array path", () => {
  afterEach(async () => { await closePooledDbs(); });

  it("a query-builder SELECT returns correctly mapped rows through the guard", async () => {
    const db = makePooledDb(URL, { acquireTimeoutMs: ACQUIRE_MS });
    await db.execute(raw`drop table if exists tf_acquire_chain_probe`);
    await db.execute(raw`create table tf_acquire_chain_probe (id int primary key, label text)`);
    try {
      await db.insert(probe).values([{ id: 1, label: "one" }, { id: 2, label: "two" }]);

      // `.values()` + `mapResultRow`: if the proxy unwrapped itself, these come back as raw
      // positional arrays rather than named columns, and this comparison is what catches it.
      const rows = await db.select().from(probe).orderBy(probe.id);
      expect(rows).toEqual([{ id: 1, label: "one" }, { id: 2, label: "two" }]);
    } finally {
      await db.execute(raw`drop table if exists tf_acquire_chain_probe`).catch(() => {});
    }
  }, 60_000);

  /**
   * TRANSACTIONS STILL WORK, WHICH IS NOT FREE. The ceiling's proxy overrides `unsafe` and `begin`,
   * and `begin` is how every mutation in the API reaches Postgres — a proxy that broke it would
   * break every write while leaving all four refusal guards green. The begin arm's own refusal is
   * in `pooled-db.pg.test.ts`. This pins the deliberate scope: work INSIDE a transaction runs on a
   * reserved connection via the driver's own inner handle, unproxied, so the ceiling bounds only
   * the wait to begin and never interrupts an open transaction — worse than the 504 it fixes.
   */
  it("a transaction commits, and rolls back, through the proxied client", async () => {
    const db = makePooledDb(URL, { acquireTimeoutMs: ACQUIRE_MS });
    await db.execute(raw`drop table if exists tf_acquire_chain_probe`);
    await db.execute(raw`create table tf_acquire_chain_probe (id int primary key, label text)`);
    try {
      await db.transaction(async (tx) => {
        await tx.insert(probe).values({ id: 10, label: "committed" });
        // A statement well past the ceiling, INSIDE the transaction: it must run to completion,
        // because the ceiling has no reach here at all.
        await tx.execute(raw`select pg_sleep(0.8)`);
      });
      expect(await db.select().from(probe)).toEqual([{ id: 10, label: "committed" }]);

      await expect(db.transaction(async (tx) => {
        await tx.insert(probe).values({ id: 11, label: "rolled back" });
        throw new Error("deliberate");
      })).rejects.toThrow("deliberate");
      // The rollback reached the database — not merely the promise.
      expect(await db.select().from(probe)).toEqual([{ id: 10, label: "committed" }]);
    } finally {
      await db.execute(raw`drop table if exists tf_acquire_chain_probe`).catch(() => {});
    }
  }, 60_000);

  it("and is still REFUSED when it cannot start — the guard survives the chain", async () => {
    // The other half: a proxy that re-wraps but drops the timer would pass the test above and
    // leave every ORM read exactly as unbounded as it was before this change.
    const db = makePooledDb(URL, { acquireTimeoutMs: ACQUIRE_MS });
    await db.execute(raw`drop table if exists tf_acquire_chain_probe`);
    await db.execute(raw`create table tf_acquire_chain_probe (id int primary key, label text)`);
    try {
      const holders = await occupyAll(db, 3);

      const started = Date.now();
      await expect(db.select().from(probe))
        .rejects.toMatchObject({ name: "DbAcquireTimeoutError" });
      expect(Date.now() - started).toBeLessThan(1_500);

      await Promise.all(holders);
    } finally {
      await db.execute(raw`drop table if exists tf_acquire_chain_probe`).catch(() => {});
    }
  }, 60_000);
});
