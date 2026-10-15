import { describe, it, expect } from "vitest";
import { DEFAULT_ALERT_THRESHOLDS } from "@trafficflow/db/cloud";
import {
  evaluateHealth, anyDegradedCause, type HealthInput, type DegradedReason,
} from "../src/health.js";
import {
  DEFAULT_SERVING_NOTHING_MAX_MS, DEFAULT_STALE_CYCLE_MAX_MS, MIN_SERVING_NOTHING_MAX_MS,
} from "../src/config.js";

/**
 * THE HEALTH VERDICT'S TRUTH TABLE.
 *
 * `/health` answered `healthy: true` for the whole of the 2026-08-02 outage, because a wedged
 * worker (`leader:false, standby:true, mailboxes:0`) and a legitimate hot spare are the same
 * snapshot, and because "a leader serving nothing" was only 503 once a quarantine had been
 * recorded. Both are decided here now, and both directions of both rules matter: the one that
 * says 503 is the alarm, and the one that says 200 is what lets a deployment go live at all.
 *
 * A pure function so this file is a table and not an integration guess; the e2e counterparts —
 * a real supervisor, a real listener, real status codes — are in `health-bounds.e2e.test.ts`.
 */

const t0 = 1_700_000_000_000;
const BOUND = 120_000;
const STALE_BOUND = 480_000;

/** A leader serving two mailboxes, one second into its first good cycle. Everything healthy. */
function base(): HealthInput {
  return {
    now: t0 + 1_000,
    fatal: false,
    leader: true,
    standby: false,
    takingOver: false,
    expected: 2,
    connected: 2,
    standbySince: t0 - 5_000,
    leaderSince: t0,
    lastCycleAt: t0,
    maxMs: BOUND,
    staleCycleMaxMs: STALE_BOUND,
    databaseFault: false,
    dutyGap: false,
    unserved: 0,
    standDown: 0,
    capacityDropped: 0,
  };
}

/** A standby that has been waiting `waitedMs` for the lock — the rolling-deploy shape. */
function spare(waitedMs: number): HealthInput {
  return {
    ...base(),
    now: t0 + waitedMs,
    leader: false, standby: true, takingOver: false,
    expected: 0, connected: 0,
    standbySince: t0, leaderSince: null, lastCycleAt: null,
  };
}

describe("evaluateHealth", () => {
  it("a serving leader is healthy", () => {
    expect(evaluateHealth(base())).toEqual({
      healthy: true, degraded: false, degradedReason: null, unhealthyReason: null,
    });
  });

  // ── RULE 1: THE LEADER THAT SERVES NOTHING ───────────────────────────────────────────────

  it("a leader with 0 of 2 expected mailboxes is UNHEALTHY once it is past the bound", () => {
    // No quarantine recorded — which is the correction. The old rule required
    // `quarantined > 0` and therefore answered 200 for every other way of serving nothing:
    // a mailbox with no credential row, a roster pass that never finished, the
    // `roster_invariant_violated` gap. Zero of N is zero of N.
    const v = evaluateHealth({ ...base(), connected: 0, unserved: 2, now: t0 + BOUND });
    expect(v).toEqual({
      healthy: false, degraded: true,
      // The shortfall names it, not the 503 — the unhealthy token is the FLOOR of the ranking and
      // only wins when nothing more specific is present (see the `fatal` cases below).
      degradedReason: "roster_shortfall", unhealthyReason: "serving_nothing",
    });
  });

  it("…and is HEALTHY inside the bound, which is what keeps a cold deploy shippable", () => {
    // The direction that is easy to get wrong. Railway gates a DEPLOYMENT on this endpoint, and
    // a cold start (nothing holding the lock — i.e. right after the previous instance crashed)
    // reaches `leader` within seconds. If the reason nothing attaches is external — the provider
    // is down — a rule that answers 503 at once fails the deploy of the build that fixes something else.
    const v = evaluateHealth({ ...base(), connected: 0, now: t0 + BOUND - 1 });
    expect(v.healthy).toBe(true);
    expect(v.unhealthyReason).toBeNull();
  });

  it("measures the serving-nothing clock from the LAST GOOD CYCLE, not from the takeover", () => {
    // A leader that served for an hour and then lost every mailbox must be called out two
    // minutes later — not two minutes after it took over, which was an hour ago.
    const leaderSince = t0;
    const lastCycleAt = t0 + 3_600_000;
    expect(evaluateHealth({
      ...base(), connected: 0, leaderSince, lastCycleAt, now: lastCycleAt + BOUND - 1,
    }).healthy).toBe(true);
    expect(evaluateHealth({
      ...base(), connected: 0, leaderSince, lastCycleAt, now: lastCycleAt + BOUND,
    }).unhealthyReason).toBe("serving_nothing");
  });

  it("a PARTIAL failure stays healthy however long it lasts", () => {
    // One bad customer must never take down every other account's sync. `degraded` still says
    // so, and that is the field an operator reads; `healthy` is about the INSTANCE. The cycle
    // stays fresh here so this is only about the partial failure — staleness is RULE 3's.
    const v = evaluateHealth({
      ...base(), expected: 2, connected: 1, unserved: 1,
      now: t0 + 10 * BOUND, lastCycleAt: t0 + 10 * BOUND - 1_000,
    });
    expect(v).toEqual({
      healthy: true, degraded: true, degradedReason: "roster_shortfall", unhealthyReason: null,
    });
  });

  it("a leader with nothing to serve is healthy — `expected: 0` is not a fault", () => {
    const v = evaluateHealth({ ...base(), expected: 0, connected: 0, now: t0 + 10 * BOUND });
    expect(v.healthy).toBe(true);
  });

  // ── RULE 2: THE STANDBY THAT NEVER STARTS ────────────────────────────────────────────────

  it("a hot spare inside the bound answers healthy — a deploy handover is ~5 s", () => {
    // If this ever goes false, no deployment can go active: Railway will not stop the outgoing
    // instance until the incoming one is healthy, and the incoming one is a STANDBY for the
    // whole of that window. This assertion is the deploy pipeline.
    expect(evaluateHealth(spare(5_228)).healthy).toBe(true);
    expect(evaluateHealth(spare(BOUND - 1)).healthy).toBe(true);
  });

  it("a standby past the bound is UNHEALTHY — the wedge that hid an 8-minute outage", () => {
    const v = evaluateHealth(spare(BOUND));
    expect(v).toEqual({
      healthy: false, degraded: true,
      // A standby has no roster, so nothing outranks the floor and the two fields agree.
      degradedReason: "waiting_for_lock", unhealthyReason: "waiting_for_lock",
    });
  });

  it("a TAKEOVER in flight is never `waiting_for_lock`, however long it takes", () => {
    // It holds the lock; it is inside `startWorkerWithLock`, i.e. inside the initial roster and
    // its attaches. A real first sync measured many minutes for a large mailbox, and calling that
    // instance broken is the same mistake the heartbeat pulse was written to stop making.
    const v = evaluateHealth({ ...spare(60 * 60 * 1000), takingOver: true });
    expect(v.healthy).toBe(true);
  });

  // ── RULE 3: THE CONNECTED LEADER WHOSE CYCLE WENT STALE ──────────────────────────────────

  it("a leader with CONNECTED mailboxes and a stale cycle is DEGRADED — and never unhealthy", () => {
    // The blind spot the two rules above cannot see: `serving_nothing` requires
    // `connected === 0`, so a leader whose mailboxes were all attached but whose cycle had
    // stopped completing read `healthy: true, degraded: false` for ever — measured 2026-08-07
    // at `lagSeconds: 560` during a cold backfill, green throughout. Degraded and not
    // unhealthy, because Railway gates deployments on this endpoint: a slow cycle must not be
    // able to refuse a deploy; what it must stop doing is hiding.
    const v = evaluateHealth({ ...base(), now: t0 + STALE_BOUND });
    expect(v).toEqual({
      healthy: true, degraded: true, degradedReason: "stale_cycle", unhealthyReason: null,
    });
  });

  it("…and is NOT degraded while the cycle is inside the bound", () => {
    const v = evaluateHealth({ ...base(), now: t0 + STALE_BOUND - 1 });
    expect(v).toEqual({
      healthy: true, degraded: false, degradedReason: null, unhealthyReason: null,
    });
  });

  it("the measured takeover shape — one long FIRST cycle — cannot trip it, however long", () => {
    // A first post-takeover cycle measured minutes on the hosted service, and it
    // is legitimate: the drain is doing exactly what it should. The protection is STRUCTURAL,
    // not a margin: the rule keys on `lastCycleAt` — a COMPLETED cycle — and never falls back
    // to `leaderSince`, so a fresh leader has no completed cycle to be stale about until its
    // first one lands.
    const v = evaluateHealth({
      ...base(), lastCycleAt: null, leaderSince: t0, now: t0 + 60 * 60 * 1000,
    });
    expect(v).toEqual({
      healthy: true, degraded: false, degradedReason: null, unhealthyReason: null,
    });
  });

  // ── PRECEDENCE AND THE FATAL PATH ────────────────────────────────────────────────────────

  it("a fatal (lost lock / failed takeover) outranks every clock", () => {
    const v = evaluateHealth({ ...base(), fatal: true });
    expect(v).toEqual({
      healthy: false, degraded: true, degradedReason: "fatal", unhealthyReason: "fatal",
    });
  });

  it("…and a fatal with a roster cause reports BOTH — the 503 token never crowds out the cause", () => {
    // Why the unhealthy tokens rank last. `unhealthyReason` is already in the body of a 503, so
    // repeating it in `degradedReason` costs a field that could have said something else.
    expect(evaluateHealth({ ...base(), fatal: true, dutyGap: true })).toEqual({
      healthy: false, degraded: true, degradedReason: "duty_gap", unhealthyReason: "fatal",
    });
  });

  // ── RULE 4: EVERY DEGRADED STATE NAMES ITSELF (HEALTH-REASON) ────────────────────────────────────

  it("a roster shortfall is `roster_shortfall`, not an unexplained `degraded: true`", () => {
    // THE MEASURED DEFECT. Two production deploy probes read `n/m degraded: true,
    // degradedReason: null`, and both times whoever read it went hunting for a fault that
    // was not there — the field could only ever name `stale_cycle`, so every other cause arrived
    // anonymous. `expected` vs `mailboxes` says a mailbox is missing and nothing about why.
    expect(evaluateHealth({ ...base(), expected: 13, connected: 12, unserved: 1 })).toEqual({
      healthy: true, degraded: true, degradedReason: "roster_shortfall", unhealthyReason: null,
    });
  });

  it("a duty gap outranks the shortfall it is a special case of", () => {
    // `roster_invariant_violated`: mailboxes in NO accounted-for bucket. It is always also a
    // shortfall, so a ranking that put the shortfall first would make this token unreachable.
    expect(evaluateHealth({ ...base(), connected: 1, unserved: 1, dutyGap: true }).degradedReason)
      .toBe("duty_gap");
  });

  it("the capacity cap names itself — the quietest arm, and the only one no clock fixes", () => {
    // Capped mailboxes are not counted in `expected`, so the shortfall is zero and every other
    // count on the body reads healthy. `TF_MAX_MAILBOXES` or a shard; nothing else clears it.
    expect(evaluateHealth({ ...base(), capacityDropped: 3 })).toEqual({
      healthy: true, degraded: true, degradedReason: "at_capacity", unhealthyReason: null,
    });
  });

  it("the full ranking, cause before symptom, walked from the floor up", () => {
    // Each row adds ONE cause to the row above it and must take the field from it. Read bottom-up
    // it is the ranking: `database_fault` first on the argument (an outage produces stale
    // cycles AND shortfalls, and only one of the three is the incident), the unhealthy token last
    // so the chain is total without ever crowding out something more specific.
    const stale = { ...base(), now: t0 + STALE_BOUND };
    expect(evaluateHealth({ ...base(), fatal: true }).degradedReason).toBe("fatal");
    expect(evaluateHealth({ ...stale, fatal: true }).degradedReason).toBe("stale_cycle");
    expect(evaluateHealth({ ...stale, capacityDropped: 1 }).degradedReason).toBe("at_capacity");
    expect(evaluateHealth({ ...stale, capacityDropped: 1, unserved: 1 }).degradedReason).toBe("roster_shortfall");
    expect(evaluateHealth({ ...stale, unserved: 1, dutyGap: true }).degradedReason).toBe("duty_gap");
    expect(evaluateHealth({ ...stale, dutyGap: true, databaseFault: true }).degradedReason).toBe("database_fault");
  });

  // ── RULE 5: A MAILBOX ANOTHER ORGANIZER HOLDS IS NOT THIS WORKER'S DEFECT ────────────────

  it("a stand-down does NOT degrade — dual mode working is not a fault", () => {
    // The ruling, 2026-08-14, against the project's design notes §4. Exactly one active
    // organizer per mailbox is the invariant; a Cloud worker meeting a fresh `local` claim stands
    // down and is at that moment doing what the product says it does. It was counted, and it is
    // half the measured oscillation: `13/13 degraded: false` ↔ `12/13 degraded: true` on an
    // account whose desktop install holds the lease exactly as designed. That reading was not
    // merely unexplained, it was WRONG — and it would grow by one per dual-mode user.
    expect(evaluateHealth({ ...base(), expected: 13, connected: 12, unserved: 0, standDown: 1 }))
      .toEqual({ healthy: true, degraded: false, degradedReason: null, unhealthyReason: null });
  });

  it("…but an UNREADABLE lease still does, because then nobody is organizing it", () => {
    // The two lease populations are not the same state — `index.ts`'s `SyncBlock` header says so
    // and `unservedBreakdown` splits them on the same discriminator. `lease_unreadable` lands in
    // `unserved`, so it reaches the calculus; a stand-down lands in `standDown` and does not.
    expect(evaluateHealth({ ...base(), expected: 13, connected: 12, unserved: 1, standDown: 0 })
      .degradedReason).toBe("roster_shortfall");
  });

  it("a shard whose WHOLE duty is organized elsewhere is healthy, not `serving_nothing`", () => {
    // The ruling has to reach the rule that answers 503 too, or it is a preference rather than a ruling: a
    // Cloud shard serving zero mailboxes because desktop installs hold every lease is correct,
    // and 503 there would refuse deployments over the product working. It is not a new policy —
    // `expected: 0` has never been a fault — only the statement that a mailbox somebody else
    // organizes is not part of what this worker is owed.
    const all = { ...base(), expected: 2, connected: 0, standDown: 2, now: t0 + 10 * BOUND };
    expect(evaluateHealth(all)).toEqual({
      healthy: true, degraded: false, degradedReason: null, unhealthyReason: null,
    });
    // …and one mailbox NOT stood down is still owed, so the rule that answers 503 is intact.
    expect(evaluateHealth({ ...all, standDown: 1, unserved: 1 }).unhealthyReason)
      .toBe("serving_nothing");
  });

  it("the reason set is CLOSED — every token the ranking can emit is a declared one", () => {
    // A published field. Adding a branch to `causeOf` without adding it here (and to the
    // `DegradedReason` union, and to the operator docs that read it) fails this.
    const declared: readonly DegradedReason[] = [
      "database_fault", "duty_gap", "roster_shortfall", "at_capacity", "stale_cycle",
      "fatal", "serving_nothing", "waiting_for_lock",
    ];
    const emitted = new Set(states().map((s) => evaluateHealth(s).degradedReason));
    emitted.delete(null);
    expect([...emitted].sort()).toEqual([...declared].sort());
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE INVARIANT, OVER EVERY CONSTRUCTIBLE STATE — HEALTH-REASON
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `degraded: true` with `degradedReason: null` must not be a value the endpoint can publish.
 *
 * The first half of that is structural: `evaluateHealth` computes the token and DERIVES `degraded`
 * from it, so `degraded === (degradedReason !== null)` is a tautology over the shipped code. A
 * guard that checked only that would be vacuous — it stays green under every mutation, including
 * deleting a cause from the ranking outright, because deleting the name deletes the `degraded`
 * with it. It is asserted anyway, as the thing that would catch someone re-introducing an
 * independent `degraded` expression.
 *
 * The half that has teeth is the SECOND assertion: `degraded` recomputed here, from the inputs,
 * without reference to the implementation's ranking. Drop `roster_shortfall` from `causeOf` and
 * the state that only had a shortfall goes `degraded: false` while this test still expects true.
 * Both mutations were run (see the slice report); each takes this file red.
 */
function states(): HealthInput[] {
  const out: HealthInput[] = [];
  // Every axis that can move the verdict, at the values on both sides of each rule's boundary.
  // Thousands of states — a full cross product rather than a sample, because the state this exists to
  // rule out was reached by a combination nobody had listed.
  for (const fatal of [false, true]) {
    for (const role of [
      { leader: true, standby: false, takingOver: false },
      { leader: false, standby: true, takingOver: false },
      { leader: false, standby: true, takingOver: true },
    ]) {
      for (const expected of [0, 2]) {
        for (const connected of [0, 2]) {
          for (const standDown of [0, 1, 2]) {
            for (const unserved of [0, 1]) {
              for (const dutyGap of [false, true]) {
                for (const databaseFault of [false, true]) {
                  for (const capacityDropped of [0, 1]) {
                    // null (never completed a cycle), fresh, and past the stale bound.
                    for (const lastCycleAt of [null, t0 + 10 * BOUND, t0]) {
                      out.push({
                        ...role, fatal, expected, connected, standDown, unserved, dutyGap,
                        databaseFault, capacityDropped, lastCycleAt,
                        now: t0 + 10 * BOUND, standbySince: t0, leaderSince: t0,
                        maxMs: BOUND, staleCycleMaxMs: STALE_BOUND,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}

describe("the degraded invariant (HEALTH-REASON)", () => {
  it("enumerates every constructible health state and none is degraded without a reason", () => {
    const all = states();
    expect(all.length).toBe(3_456);           // the cross product actually ran

    for (const input of all) {
      const v = evaluateHealth(input);
      const where = JSON.stringify(input);

      // (1) The structural half. Vacuous against the shipped derivation, and the tripwire for
      //     anyone who reintroduces a `degraded:` expression that does not go through `causeOf`.
      expect(v.degraded, `degraded without a reason: ${where}`)
        .toBe(v.degradedReason !== null);

      // (2) The half with teeth: `degraded` recomputed from the INPUTS. The stale-cycle predicate
      //     is restated rather than imported, so a mutation of the rule in `health.ts` shows up
      //     here as a disagreement instead of being carried along by a shared helper.
      const staleCycle = input.leader && input.connected > 0 && input.lastCycleAt !== null
        && input.now - input.lastCycleAt >= input.staleCycleMaxMs;
      expect(v.degraded, `the degraded calculus disagrees: ${where}`)
        .toBe(anyDegradedCause(input) || staleCycle || v.unhealthyReason !== null);

      // (3) The ruling: a stand-down on its own never degrades and never 503s, however many.
      if (!anyDegradedCause(input) && !staleCycle && !input.fatal && input.standDown >= input.expected
          && !(input.standby && !input.takingOver)) {
        expect(v.degraded, `a legitimate hand-off was called a fault: ${where}`).toBe(false);
        expect(v.healthy, `a legitimate hand-off refused a deploy: ${where}`).toBe(true);
      }
    }
  });
});

describe("evaluateHealth bounds", () => {
  it("the shipped bound clears a measured handover by 23× and Railway's own gate by 2×", () => {
    // `railway.toml` states both as facts. They are arithmetic on these two constants, so they
    // are checkable here rather than only readable there.
    expect(DEFAULT_SERVING_NOTHING_MAX_MS / 5_228).toBeGreaterThan(20);
    expect(MIN_SERVING_NOTHING_MAX_MS).toBe(60_000);          // == healthcheckTimeout, in ms
    expect(DEFAULT_SERVING_NOTHING_MAX_MS).toBeGreaterThanOrEqual(MIN_SERVING_NOTHING_MAX_MS);
  });

  it("the stale-cycle bound clears the measured takeover and stays under the pager", () => {
    // Three relationships, all load-bearing (the constant's header in `config.ts` names them):
    // above the unhealthy bound (a DEGRADED hint must not be sharper than the 503 it softens),
    // above the ~5-minute first post-takeover cycle measured on the hosted service with margin,
    // and below `DEFAULT_ALERT_THRESHOLDS.syncLagMs` so `/health` turns amber before the pager
    // fires — the endpoint must never know less than the alert pass.
    expect(STALE_BOUND).toBe(DEFAULT_STALE_CYCLE_MAX_MS);     // the table above tests the shipped value
    expect(DEFAULT_STALE_CYCLE_MAX_MS).toBeGreaterThan(DEFAULT_SERVING_NOTHING_MAX_MS);
    expect(DEFAULT_STALE_CYCLE_MAX_MS).toBeGreaterThanOrEqual(6 * 60_000);
    expect(DEFAULT_STALE_CYCLE_MAX_MS).toBeLessThan(DEFAULT_ALERT_THRESHOLDS.syncLagMs);
  });
});
