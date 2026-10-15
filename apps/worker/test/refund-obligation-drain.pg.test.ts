import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { eq } from "drizzle-orm";
import { accounts, reverseCharge, sourceFor, type SpendPort, type SpendRelease, type Tx } from "@trafficflow/db";
import {
  schema, pendingRefundObligations, recordRefundObligation, claimRefundObligations, refundObligationsOn,
} from "@trafficflow/db/cloud";
import type { LogFields, Logger } from "@trafficflow/core";
import { refundObligationDrainPass } from "../src/refund-obligation-drain.js";

/**
 * A SPEND THAT BOUGHT NOTHING IS REFUNDED — the obligation row and its drain, on real Postgres.
 *
 * Real Postgres and not PGlite, for the reason the auto-suggest suite gives: every claim here is
 * about MONEY and about ORDERING, and both live in database objects rather than application code.
 * `credit_refund_obligations_attempt_unique` is what makes recording one failure twice one debt;
 * `FOR UPDATE SKIP LOCKED` inside the claim is what makes two drains unable to dial for one row.
 * A PGlite green would say nothing about either.
 *
 * ## The unit, quoted
 *
 * Money here is CREDITS, and that is the vendor's own word for it: `ledger-source.ts:215` —
 * "What each metered action costs, in credits — the price list, pinned per reason" — with
 * `AI_ACTION_WEIGHTS.debit_draft = 15`, the same 15 the webapp quotes as
 * `DRAFT_REPLY_COST_CREDITS`. Not cents, not a currency: this server never sees a price. The fake
 * program below holds an integer credit balance and nothing else, so every number in this file is
 * in the one unit both sides name.
 *
 * ## The mutations each case was watched red under
 *
 *  1. delete the `owe` call in `releaseClaim`/`draftFromMessage` → the debt is gone after a lost
 *     release and the balance never comes back;
 *  2. settle unconditionally instead of on `receipt === "settled"` → the debt is marked paid while
 *     the program never took it, and the balance stays short;
 *  3. drop `isNull(settledAt)` from `settleRefundObligation` → a replay pays twice.
 */

const AVAILABLE = await realPgAvailable();

/**
 * THE ENTITLEMENTS PROGRAM, AS THE FAR SIDE ACTUALLY BEHAVES — an integer credit balance, a
 * per-source claim book, and the `refund:<attempt>` uniqueness that is the other half of this
 * lane's idempotency.
 *
 * It is a fake of the PROGRAM and not of the port, which is the difference that matters: the
 * question "does a replayed drain pay twice" is only answerable against something that keeps a
 * balance and remembers which reversals it has already applied. A double that merely counted
 * `release` calls would answer it by construction and prove nothing.
 */
interface FakePlane extends SpendPort {
  balance(): number;
  /** Every later release answers `unreachable` and moves nothing. The outage. */
  goDown(): void;
  up(): void;
  /** How many reversals the program actually APPLIED — not how many were asked for. */
  reversals(): number;
  /** The same, for one account: a drain over the shared table also takes other cases' leftovers. */
  reversalsFor(accountId: string): number;
}

function fakePlane(credits: number, cost = 15): FakePlane {
  let balance = credits;
  let down = false;
  let reversals = 0;
  const perAccount = new Map<string, number>();
  /** `refund:<attempt>` — the program's own uniqueness, which is why a replay is safe. */
  const reversed = new Set<string>();
  const held = new Map<string, string>();
  let issued = 0;
  return {
    balance: () => balance,
    goDown() { down = true; },
    up() { down = false; },
    reversals: () => reversals,
    reversalsFor: (accountId) => perAccount.get(accountId) ?? 0,
    async spend(_accountId, action, attemptKey) {
      const source = sourceFor(action, attemptKey);
      const open = held.get(source);
      if (open) return { verdict: "duplicate", charged: false, attempt: open };
      if (balance < cost) return { verdict: "insufficient", reason: "out_of_credits" };
      balance -= cost;
      const attempt = `attempt-${++issued}`;
      held.set(source, attempt);
      return { verdict: "ok", charged: true, attempt };
    },
    async release(accountId, r: SpendRelease) {
      if (down) return "unreachable";
      const source = sourceFor(r.action, r.attemptKey);
      if (r.refund) {
        held.delete(source);
        const key = `refund:${r.attempt}`;
        // EXACTLY ONCE, ON THE PROGRAM'S SIDE. A second reversal of one attempt is accepted and
        // moves nothing — which is precisely what makes re-sending a release whose answer was
        // lost the right thing for the drain to do.
        if (!reversed.has(key)) {
          reversed.add(key);
          balance += cost;
          reversals += 1;
          perAccount.set(accountId, (perAccount.get(accountId) ?? 0) + 1);
        }
      }
      return "settled";
    },
  };
}

function recordingLog(): Logger & { lines: Array<{ level: string; event: string }> } {
  const lines: Array<{ level: string; event: string }> = [];
  const at = (level: string) => (event: string, _f?: LogFields) => { lines.push({ level, event }); };
  return {
    lines,
    debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"),
  } as unknown as Logger & { lines: Array<{ level: string; event: string }> };
}

describe.skipIf(!AVAILABLE)("REFUND-OBLIGATION — a spend that bought nothing leaves a row", () => {
  let db: Tx;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    const sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Tx;
  }, 120_000);

  async function newAccount(): Promise<string> {
    const id = randomUUID();
    await db.insert(accounts).values({ id, name: `obl-${id.slice(0, 8)}` });
    return id;
  }

  /** The sequence: charge, the work fails, the debt is written, the reversal is attempted. */
  async function chargeThenFail(
    accountId: string, plane: FakePlane, messageId = randomUUID(),
  ): Promise<string> {
    // THE BARE KEY, which is what `draftAttemptKey` produces: `<message id>:<hashed client key>`.
    // The first cut wrote `draft:<id>` here and `sourceFor` refused it by name — a composed source
    // where a bare key belongs is double-prefixed, passes the namespace CHECK and the UNIQUE, and
    // charges already-paid work a second time. The fixture is held to the rule production is held
    // to, which is the only way this file measures the real composition.
    const attemptKey = `${messageId}:k1`;
    const out = await plane.spend(accountId, "draft", attemptKey);
    expect(out.verdict).toBe("ok");
    const attempt = (out as { attempt: string }).attempt;
    // THE ORDER THAT IS THE FIX: the debt is written BEFORE the reversal is tried, so a program
    // that never answers leaves the obligation standing rather than nothing.
    await recordRefundObligation(db, {
      accountId, action: "draft", attemptKey, attempt,
      reason: "drafter_failed", meta: { messageId },
    });
    const receipt = await plane.release(accountId, {
      action: "draft", attemptKey, refund: true, attempt, meta: { messageId },
    });
    expect(receipt).toBe("unreachable");
    return attempt;
  }

  it("1 — the refund call fails, the debt stands, and a later pass settles it", async () => {
    const accountId = await newAccount();
    const plane = fakePlane(100);
    plane.goDown();

    const attempt = await chargeThenFail(accountId, plane);

    // 15 credits gone and no reversal: this is the person who paid for a draft they never got.
    expect(plane.balance()).toBe(85);
    expect(plane.reversals()).toBe(0);

    const owed = await pendingRefundObligations(db, accountId);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ action: "draft", attempt, reason: "drafter_failed" });

    // The outage ends and the drain runs.
    plane.up();
    const r = await refundObligationDrainPass(db, { credits: plane, log: recordingLog() });

    expect(r.settled).toBeGreaterThanOrEqual(1);
    expect(plane.balance()).toBe(100);
    expect(plane.reversals()).toBe(1);
    expect(await pendingRefundObligations(db, accountId)).toEqual([]);
  });

  it("2 — a replay of the pass does not refund twice", async () => {
    const accountId = await newAccount();
    const plane = fakePlane(100);
    plane.goDown();
    await chargeThenFail(accountId, plane);
    plane.up();

    await refundObligationDrainPass(db, { credits: plane, log: recordingLog() });
    expect(plane.balance()).toBe(100);

    // Three more passes over the same table. The row is settled, so it is never claimed again;
    // and even if it were, the program's `refund:<attempt>` uniqueness moves nothing.
    for (let i = 0; i < 3; i += 1) {
      await refundObligationDrainPass(db, { credits: plane, log: recordingLog() });
    }
    expect(plane.balance()).toBe(100);
    expect(plane.reversals()).toBe(1);
    expect(await pendingRefundObligations(db, accountId)).toEqual([]);
  });

  it("2b — observing one failure twice owes ONE debt, not two", async () => {
    const accountId = await newAccount();
    const plane = fakePlane(100);
    const messageId = randomUUID();
    const attemptKey = `${messageId}:k1`;
    const out = await plane.spend(accountId, "draft", attemptKey);
    const attempt = (out as { attempt: string }).attempt;

    for (let i = 0; i < 4; i += 1) {
      await recordRefundObligation(db, {
        accountId, action: "draft", attemptKey, attempt, reason: "drafter_failed",
      });
    }
    expect(await pendingRefundObligations(db, accountId)).toHaveLength(1);

    await refundObligationDrainPass(db, { credits: plane, log: recordingLog() });
    expect(plane.balance()).toBe(100);
    expect(plane.reversals()).toBe(1);
  });

  it("3 — a release that THROWS is logged once, leaves the debt, and stops nobody else", async () => {
    const a = await newAccount();
    const b = await newAccount();
    const plane = fakePlane(200);
    plane.goDown();
    const attemptA = await chargeThenFail(a, plane);
    await chargeThenFail(b, plane);
    plane.up();

    // A port that raises for ONE account. Production's `release` never throws, which is exactly
    // why this arm exists: the drain must not turn a contract violation into a dead pass.
    const raising: SpendPort = {
      spend: plane.spend.bind(plane),
      release: async (accountId, r) => {
        if (accountId === a) throw new Error("the program blew up");
        return plane.release(accountId, r);
      },
    };
    const log = recordingLog();
    const r = await refundObligationDrainPass(db, { credits: raising, log });

    // ONE line for the fault, and the pass's own result is unchanged by it: the other account's
    // debt was settled in the same batch.
    const failed = log.lines.filter((l) => l.event === "refund_obligation_release_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.level).toBe("warn");
    expect(r.claimed).toBe(2);
    expect(r.settled).toBe(1);
    expect(r.owed).toBe(1);

    // A's debt is still owed and named; B has their credits back.
    const stillOwed = await pendingRefundObligations(db, a);
    expect(stillOwed).toHaveLength(1);
    expect(stillOwed[0]!.attempt).toBe(attemptA);
    expect(await pendingRefundObligations(db, b)).toEqual([]);

    // And the next pass finishes it — the lease was dropped, not waited out.
    await refundObligationDrainPass(db, { credits: plane, log: recordingLog() });
    expect(await pendingRefundObligations(db, a)).toEqual([]);
  });

  it("4 — a claimed row is not claimable again while its lease holds", async () => {
    const accountId = await newAccount();
    const plane = fakePlane(100);
    plane.goDown();
    await chargeThenFail(accountId, plane);
    plane.up();

    const now = new Date();
    const first = await claimRefundObligations(db, now, { limit: 10, leaseMs: 60_000 });
    expect(first.filter((o) => o.accountId === accountId)).toHaveLength(1);

    // A second drain arriving inside the lease sees nothing of this row.
    const second = await claimRefundObligations(db, now, { limit: 10, leaseMs: 60_000 });
    expect(second.filter((o) => o.accountId === accountId)).toEqual([]);

    // Past the lease it comes back — a worker that died mid-drain returns its debts by the clock.
    const later = new Date(now.getTime() + 61_000);
    const third = await claimRefundObligations(db, later, { limit: 10, leaseMs: 60_000 });
    expect(third.filter((o) => o.accountId === accountId)).toHaveLength(1);
    expect(third.find((o) => o.accountId === accountId)!.tries).toBe(2);
  });

  it("4b — an ERASED account owes nothing: the debt is refused, not written", async () => {
    const accountId = await newAccount();
    const plane = fakePlane(100);
    const messageId = randomUUID();
    const attemptKey = `${messageId}:k1`;
    const out = await plane.spend(accountId, "draft", attemptKey);
    const attempt = (out as { attempt: string }).attempt;

    // Art. 17 lands between the charge and the failure. `accounts` is the row erasure KEEPS, so
    // nothing would ever clear a debt written after it — the writer has to refuse, and it is the
    // one db-layer primitive that must fence itself, because it deliberately writes OUTSIDE the
    // transaction that failed and therefore inherits nobody else's fence.
    await db.update(accounts).set({ erasedAt: new Date() }).where(eq(accounts.id, accountId));

    await recordRefundObligation(db, {
      accountId, action: "draft", attemptKey, attempt, reason: "drafter_failed",
    });
    expect(await pendingRefundObligations(db, accountId)).toEqual([]);

    // And the positive control, so the case cannot pass by the writer being broken for everyone:
    // the same write on a LIVE account lands.
    const live = await newAccount();
    await recordRefundObligation(db, {
      accountId: live, action: "draft", attemptKey, attempt, reason: "drafter_failed",
    });
    expect(await pendingRefundObligations(db, live)).toHaveLength(1);
  });

  it("5 — an unmetered host runs no drain and reads no table", async () => {
    const r = await refundObligationDrainPass(db, { log: recordingLog() });
    expect(r).toEqual({ claimed: 0, settled: 0, owed: 0 });
  });

  it("6 — a settle that FAILS after a settled refund leaves the debt; the drain's re-send moves nothing and settles it", async () => {
    // The door is the shared `reverseCharge`, its settle on a connection that has ENDED — a real
    // failure. The program took the refund, so the open debt the drain re-sends names an attempt
    // the program already reversed: its `refund:<attempt>` rule answers it and moves nothing.
    // Counted for THIS account: the drain also takes whatever earlier cases left on the table.
    const accountId = await newAccount();
    const plane = fakePlane(100);
    const attemptKey = `${randomUUID()}:k1`;
    const out = await plane.spend(accountId, "draft", attemptKey);
    const attempt = (out as { attempt: string }).attempt;
    const ended = postgres(PG_TEST_URL, { max: 1, onnotice: () => {} });
    await ended.end();
    const live = refundObligationsOn(db);
    const endedStore = refundObligationsOn(brandDialect(drizzle(ended, { schema }), "pg") as unknown as Tx);
    const said: string[] = [];

    const done = await reverseCharge(plane, {
      owe: (o) => live.owe(o), settle: (acct, att) => endedStore.settle(acct, att),
    }, { accountId, action: "draft", attemptKey, attempt, reason: "drafter_failed" }, (f) => { said.push(f.fact); });

    expect(done).toEqual({ receipt: "settled", owed: true });
    expect(said).toEqual(["settle_failed"]);
    expect(plane.reversalsFor(accountId)).toBe(1);
    expect(await pendingRefundObligations(db, accountId)).toEqual([expect.objectContaining({ attempt })]);

    const r = await refundObligationDrainPass(db, { credits: plane, log: recordingLog() });

    expect(r.settled).toBeGreaterThanOrEqual(1);
    expect(plane.reversalsFor(accountId), "the drain's re-send paid the refund a second time").toBe(1);
    expect(await pendingRefundObligations(db, accountId)).toEqual([]);
  });
});
