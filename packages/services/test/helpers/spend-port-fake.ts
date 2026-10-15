import {
  sourceFor,
  type ReleaseReceipt, type SpendMeta, type SpendOutcome, type SpendPort, type SpendRelease,
} from "@trafficflow/db";

/**
 * A RECORDING SPEND PORT — what a call site asked about money, and nothing about a ledger.
 *
 * It replaced a fixture that built a subscription row and a real credit ledger, and the
 * difference is the boundary: whether a charge is exactly-once, refundable and refused when the
 * balance is empty is the entitlements program's property and is proven on its side. What is
 * still this repository's is whether each call site ASKS, with which action and which bare
 * attempt key, and what it does with each of the five verdicts.
 *
 * FAILS THE WAY THE SERVER FAILS: `spend` and `release` never throw — a fault is the `fault`
 * verdict, exactly as the port states — so a double that raised would exercise an arm no
 * production caller can reach. `assertAttemptKey`'s throw is the one exception and it belongs
 * to `sourceFor`, which this double calls for real: a key that is already a source is refused
 * here as it is in both implementations.
 */
export interface SpendCall {
  accountId: string;
  action: Parameters<SpendPort["spend"]>[1];
  /** The BARE key the call site passed. */
  attemptKey: string;
  /** What `sourceFor` composes from the pair — the value a ledger would have keyed on. */
  source: string;
  meta?: SpendMeta;
  /**
   * WHAT THE PORT ANSWERED. Recorded beside the ask because a caller's behaviour is only
   * readable against the verdict it was given — and because "how many were CHARGED" is
   * otherwise indistinguishable from "how many asked", which is the count a ledger used to
   * answer.
   */
  outcome: SpendOutcome;
}

export interface FakeSpendPort extends SpendPort {
  readonly spends: SpendCall[];
  readonly releases: Array<SpendRelease & { accountId: string }>;
  /**
   * Answer this verdict to every later `spend`, OVERRIDING {@link FakeSpendPort.exclusive} and
   * {@link FakeSpendPort.budget}. An override, because that is what a case that calls it means:
   * before this, a standing `inflight` was silently ignored while exclusivity was on — the
   * source was unheld, so the double answered `ok` and the case under it passed for the wrong
   * reason.
   */
  answer(v: SpendOutcome): void;
  /** Answer once, then fall back to the standing verdict. */
  answerOnce(v: SpendOutcome): void;
  /**
   * A BALANCE, AS A COUNTER — admit `n` more spends and refuse every one after with
   * `insufficient`. It is what a case whose subject is "stops at the balance" needs, and it is
   * deliberately a count rather than a ledger: how a balance is kept is the entitlements
   * program's property, and how a call site behaves when the answers run out is this one's.
   */
  budget(n: number): void;
  /**
   * MODEL THE PORT'S OWN PER-SOURCE EXCLUSIVITY, which is the one part of the contract a call
   * site can get wrong: the FIRST spend for a source answers `ok`, another one for the SAME
   * source while it is unreleased answers `inflight` (transient, never charged, do not
   * proceed), and a source whose holder has released answers `duplicate` — the attempt was
   * paid for, so a retry is free.
   *
   * It is a fake of the CONTRACT and not of a claim table: whether the exclusivity is a unique
   * index, a row lock or a lease is the entitlements program's business, and it is proven there.
   * What this drives is whether a caller handed `inflight` stops, which is the verdict that
   * bought a second paid model call the last time it was folded into `duplicate`.
   */
  exclusive(): void;
  /**
   * ANSWER `unreachable` TO EVERY LATER RELEASE — the entitlements outage in the shape production
   * has it: the call resolves, nothing was taken, and the receipt says so. The claim book does not
   * move either, because that is what makes a release lost; a double that recorded the release and
   * then reported it lost would let a case assert a debt while already having given the claim back.
   */
  releasesAreLost(): void;
}

export function fakeSpendPort(initial: SpendOutcome = { verdict: "ok", charged: true, attempt: "1" }): FakeSpendPort {
  const spends: SpendCall[] = [];
  const releases: Array<SpendRelease & { accountId: string }> = [];
  let standing = initial;
  const queued: SpendOutcome[] = [];
  let remaining: number | null = null;
  let issued = 0;
  let exclusiveMode = false;
  /** Whether every later release is lost — see {@link FakeSpendPort.releasesAreLost}. */
  let lost = false;
  /** Whether a case has SET a standing verdict — see {@link FakeSpendPort.answer}. */
  let standingSet = false;
  /** source → the attempt that holds it, or `null` once its holder has released. */
  const held = new Map<string, string | null>();
  return {
    spends, releases,
    answer(v) { standing = v; remaining = null; standingSet = true; },
    answerOnce(v) { queued.push(v); },
    budget(n) { remaining = n; },
    exclusive() { exclusiveMode = true; },
    async spend(accountId, action, attemptKey, meta) {
      const source = sourceFor(action, attemptKey);
      const record = (outcome: SpendOutcome): SpendOutcome => {
        spends.push({ accountId, action, attemptKey, source, ...(meta ? { meta } : {}), outcome });
        return outcome;
      };
      const queuedVerdict = queued.shift();
      if (queuedVerdict) return record(queuedVerdict);
      // An explicit standing verdict outranks both the claim book and the budget.
      if (standingSet) return record(standing);
      if (exclusiveMode) {
        if (held.has(source)) {
          const holder = held.get(source);
          // Still held ⇒ the loser waits; released ⇒ the work is paid for and the retry is free.
          return record(holder === null
            ? { verdict: "duplicate", charged: false, attempt: `attempt-${source}` }
            : { verdict: "inflight", source });
        }
        if (remaining !== null) {
          if (remaining <= 0) return record({ verdict: "insufficient", reason: "out_of_credits" });
          remaining -= 1;
        }
        const attempt = `attempt-${++issued}`;
        held.set(source, attempt);
        return record({ verdict: "ok", charged: true, attempt });
      }
      if (remaining === null) return record(standing);
      // Decremented HERE and not by the caller: a budget that a lane could read and then act on
      // would let two lanes both see one credit, which is the race the counter exists to refuse.
      if (remaining <= 0) return record({ verdict: "insufficient", reason: "out_of_credits" });
      remaining -= 1;
      return record({ verdict: "ok", charged: true, attempt: `attempt-${++issued}` });
    },
    releasesAreLost() { lost = true; },
    async release(accountId, r): Promise<ReleaseReceipt> {
      releases.push({ accountId, ...r });
      if (lost) return "unreachable";
      const source = sourceFor(r.action, r.attemptKey);
      // A refund gives the WORK back too — the next asker starts over rather than being told it
      // was already paid for; a plain release keeps the charge and frees the claim.
      if (r.refund) held.delete(source);
      else if (held.has(source)) held.set(source, null);
      return "settled";
    },
  };
}
