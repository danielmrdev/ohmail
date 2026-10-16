import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { recordChange } from "../src/change-log.js";
import { runMigrations } from "../src/migrate.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { makeChangeWakeHub, IDLE_CLOSE_MS, RETRY_AFTER_MS } from "../src/change-wake.js";

/**
 * `subscribeAll` — THE HUB'S SECOND SHAPE, for a consumer that cannot name its accounts.
 *
 * `subscribe(accountId, …)` serves an `/events` stream, which knows exactly whose mail it is
 * streaming. The worker's push-wake sender does not: it has to hear about EVERY account, because
 * the accounts with a registered device are a set that changes without it being told. Enumerating
 * them and calling `subscribe` per account would be one callback per account on one LISTEN, plus a
 * roster pass to keep the set fresh, plus a window after every new registration in which that
 * account's wakes go nowhere.
 *
 * The three properties that make it safe to add beside `subscribe` rather than as a second hub:
 *
 *  1. it is COUNTED like any other subscriber, so a process whose only consumer is the sender
 *     still holds exactly ONE LISTEN and still releases it — the `streams : connections = N : 1`
 *     invariant is the whole reason this module exists and an uncounted subscriber would be a
 *     connection nothing closes;
 *  2. the two shapes are INDEPENDENT — a per-account subscriber and an all-accounts subscriber
 *     both see the same wake, and one of them throwing does not silence the other;
 *  3. the payload does not widen. `subscribeAll` gets `(accountId, seq)` because that is the
 *     entire NOTIFY payload; there is nothing else on the channel to hand over.
 */
const PG_UP = await realPgAvailable();

const writerSql = postgres(PG_TEST_URL, { max: 3 });
const writer = brandDialect(drizzle(writerSql), "pg");

const waitFor = async (predicate: () => boolean, ms = 6_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) return;
    await new Promise((r) => { setTimeout(r, 20); });
  }
};

const append = (accountId: string): Promise<bigint> => writer.transaction((tx) =>
  recordChange(tx as never, {
    accountId, entityType: "message", entityId: randomUUID(), op: "create",
  }));

describe.skipIf(!PG_UP)("makeChangeWakeHub#subscribeAll", () => {
  beforeAll(async () => { await runMigrations(PG_TEST_URL); }, 60_000);
  afterAll(async () => { await writerSql.end({ timeout: 5 }); });

  it("sees EVERY account's wake, with the account id and the seq, and nothing more", async () => {
    const hub = makeChangeWakeHub(PG_TEST_URL);
    const seen: { accountId: string; seq: bigint }[] = [];
    const stop = hub.subscribeAll((accountId, seq) => { seen.push({ accountId, seq }); });
    try {
      // Settle the LISTEN by proving it delivers — it is dialled lazily and asynchronously, so an
      // append that commits first emits its NOTIFY to nobody and Postgres does not replay it.
      const warm = randomUUID();
      const deadline = Date.now() + 15_000;
      while (seen.length === 0 && Date.now() < deadline) {
        await append(warm);
        await waitFor(() => seen.length > 0, 400);
      }
      expect(seen.length, "the LISTEN never came up").toBeGreaterThan(0);

      // TWO DIFFERENT accounts, neither of them named to the hub.
      const a = randomUUID();
      const b = randomUUID();
      const seqA = await append(a);
      const seqB = await append(b);

      await waitFor(() => seen.some((s) => s.accountId === a) && seen.some((s) => s.accountId === b));
      expect(seen.find((s) => s.accountId === a)).toEqual({ accountId: a, seq: seqA });
      expect(seen.find((s) => s.accountId === b)).toEqual({ accountId: b, seq: seqB });

      // The frame carries EXACTLY two values. A wake that grew a third field would be content on
      // a channel whose payloads surface in `pg_stat_activity` and the server log.
      for (const s of seen) expect(Object.keys(s).sort()).toEqual(["accountId", "seq"]);
    } finally {
      stop();
      await hub.end();
    }
  }, 60_000);

  it("is counted for the lazy dial and the idle close — unsubscribing the LAST one releases it", async () => {
    const hub = makeChangeWakeHub(PG_TEST_URL);
    // The dial is lazy: nothing is held before the first subscriber. `IDLE_CLOSE_MS` is the window
    // after the last unsubscribe, so the assertion here is about the ACCOUNTING, not the timer —
    // an uncounted subscriber would make `total` drop to zero while a consumer was still live,
    // and the idle close would then end a LISTEN somebody is using.
    expect(IDLE_CLOSE_MS).toBeGreaterThan(0);

    const seen: string[] = [];
    const stopAll = hub.subscribeAll((accountId) => { seen.push(accountId); });
    const acct = randomUUID();
    const stopOne = hub.subscribe(acct, () => { seen.push(`per:${acct}`); });

    try {
      const deadline = Date.now() + 15_000;
      while (seen.length === 0 && Date.now() < deadline) {
        await append(acct);
        await waitFor(() => seen.length > 0, 400);
      }
      // BOTH shapes saw the same wake — the per-account subscriber and the all-accounts one.
      await waitFor(() => seen.includes(acct) && seen.includes(`per:${acct}`));
      expect(seen).toContain(acct);
      expect(seen).toContain(`per:${acct}`);

      // Dropping the all-accounts subscriber leaves the per-account one working: the counting is
      // per subscriber, not per shape.
      stopAll();
      stopAll();                                   // idempotent, exactly as `subscribe`'s is
      const before = seen.length;
      await append(acct);
      await waitFor(() => seen.length > before);
      expect(seen.slice(before)).toEqual([`per:${acct}`]);
    } finally {
      stopOne();
      await hub.end();
    }
  }, 60_000);

  it("one subscriber's throw does not silence the other", async () => {
    const hub = makeChangeWakeHub(PG_TEST_URL);
    const acct = randomUUID();
    const perAccount: bigint[] = [];
    // The all-accounts subscriber throws on every frame. The `/events` stream beside it must still
    // be woken — the sender is a nice-to-have, the stream is the product.
    const stopAll = hub.subscribeAll(() => { throw new Error("the sender is broken"); });
    const stopOne = hub.subscribe(acct, (seq) => { perAccount.push(seq); });
    try {
      const deadline = Date.now() + 15_000;
      while (perAccount.length === 0 && Date.now() < deadline) {
        await append(acct);
        await waitFor(() => perAccount.length > 0, 400);
      }
      expect(perAccount.length, "a throwing subscribeAll callback silenced the per-account stream")
        .toBeGreaterThan(0);
    } finally {
      stopAll();
      stopOne();
      await hub.end();
    }
  }, 60_000);
});

/**
 * ── THE RETRY THIS SUBSCRIBER NEEDS AND `subscribe` DOES NOT ──────────────────────────────────
 *
 * No Postgres required: the whole point is a LISTEN that CANNOT be established, so the URL is a
 * dead port and every attempt fails fast. It is here rather than in a `.pg.` describe for that
 * reason, and it runs whether or not a server is up.
 *
 * The asymmetry it guards: the module's documented retry — "keeps trying to dial on later
 * subscribes, one attempt per RETRY_AFTER_MS" — is driven entirely by NEW subscribers calling
 * `ensureListening`. `/events` supplies a stream of them; `subscribeAll` has one consumer that
 * subscribes once at process start, so a boot-time failure used to be permanent for the life of
 * the process while the startup log claimed otherwise. A pooler at its connection limit during a
 * rolling deploy is the ordinary way to land in it.
 */
describe("makeChangeWakeHub#subscribeAll — a failed LISTEN is retried, not abandoned", () => {
  const DEAD = "postgres://u:p@127.0.0.1:1/nope?connect_timeout=1";
  /** Real time, real sockets, real retries — 120 ms apart instead of the shipped thirty seconds. */
  const FAST = 120;

  const settle = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

  it("attempts again one retry interval later, with no new subscriber to drive it", async () => {
    const attempts: string[] = [];
    const hub = makeChangeWakeHub(DEAD, { error: (e) => { attempts.push(e); } }, { retryAfterMs: FAST });
    // ONE subscriber, subscribed ONCE — the sender's exact shape. Nothing else ever calls in.
    const stop = hub.subscribeAll(() => { /* never reached: the LISTEN cannot come up */ });
    try {
      // ECONNREFUSED on a dead port is immediate, but it is REAL socket I/O rather than a timer,
      // which is why fake timers cannot drive this test at all: advancing fake time moves the
      // retry interval and never lets the dial fail. (Measured — the first attempt had not even
      // failed after `advanceTimersByTimeAsync(50)`.)
      await settle(FAST / 2);
      expect(attempts.length, "the first dial did not fail — is something answering on port 1?")
        .toBeGreaterThanOrEqual(1);
      const first = attempts.length;

      // …and then, with NO new subscriber, another attempt. This is the assertion that was false:
      // the sender subscribes once at boot, so nothing else was ever going to call `ensureListening`.
      await settle(FAST * 4);
      expect(
        attempts.length,
        "a subscribeAll consumer's failed LISTEN was never retried, so wakes stay off until restart",
      ).toBeGreaterThan(first);

      // Unsubscribing takes the retry with it — no timer outlives its only consumer.
      stop();
      const settled = attempts.length;
      await settle(FAST * 4);
      expect(attempts.length, "the retry timer outlived the subscriber it was retrying for")
        .toBe(settled);
    } finally {
      stop();
      await hub.end();
    }
  }, 30_000);

  it("end() DISARMS the retry — a released LISTEN stays released", async () => {
    /**
     * The shutdown contract. `teardown()` nulls `listening` and deliberately does NOT touch
     * `total` (closing a socket does not unsubscribe anybody), and that pair is exactly what
     * `ensureListening` reads as "no LISTEN and somebody wants one" — so the retry's next tick
     * re-opened a connection moments after `end()` had closed one. `end()` then meant "release for
     * up to one retry interval", which is not what a SIGTERM path is asking for.
     *
     * Note the subscriber is deliberately STILL REGISTERED here. Unsubscribing first is what the
     * worker's own shutdown happens to do, and it is why this was invisible: the property belongs
     * to the hub, and a caller should not have to know the ordering to get a release that lasts.
     */
    const attempts: string[] = [];
    const hub = makeChangeWakeHub(DEAD, { error: (e) => { attempts.push(e); } }, { retryAfterMs: FAST });
    const stop = hub.subscribeAll(() => { /* never reached */ });
    try {
      await settle(FAST * 3);
      const before = attempts.length;
      expect(before, "the dial never even attempted").toBeGreaterThanOrEqual(1);

      // SHUT DOWN — without unsubscribing, which is the case that was broken.
      await hub.end();

      await settle(FAST * 5);
      expect(
        attempts.length,
        "end() released the LISTEN and the retry re-opened one — the release did not last",
      ).toBe(before);
    } finally {
      stop();
      await hub.end();
    }
  }, 30_000);
});
