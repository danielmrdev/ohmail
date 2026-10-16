import { describe, expect, it } from "vitest";
import { PRESS_THREW, pressVerdict, tallyVerdicts } from "../src/press-verdict.js";
import { RESULTS, QUEUED_HOLDER } from "./fixtures/press-answers.js";

/**
 * THE ONE READING, AND WHAT IT REFUSES TO COLLAPSE.
 *
 * Four statuses, three answers, and the pair that may never be folded together: `queued` is this
 * client's retry queue and `awaiting_organizer` is the SERVER's record for another install. Both
 * are waits, and the difference is what a reader can do about them — the next drive lands one,
 * and nothing here advances the other — so the verdict keeps them apart inside `queued`.
 */
describe("pressVerdict — the one reading of a mutation result", () => {
  it("a confirmation is applied", () => {
    expect(pressVerdict(RESULTS.applied)).toEqual({ kind: "applied" });
  });

  it("a rollback is refused, carrying the server's own error", () => {
    const v = pressVerdict({ ...RESULTS.refused, error: undefined });
    expect(v.kind).toBe("refused");
  });

  it("this client's retry queue is a WAIT, and it is not the organizer's", () => {
    expect(pressVerdict(RESULTS.retry)).toEqual({ kind: "queued", wait: "retry", holder: null });
  });

  it("the organizer's record is a wait that names who it is waiting on", () => {
    expect(pressVerdict(RESULTS.organizer)).toEqual({
      kind: "queued", wait: "organizer", holder: QUEUED_HOLDER,
    });
  });

  /** A queued answer whose door named no holder — the rules family, which has none to name. */
  it("an unnamed holder is null, never invented", () => {
    const v = pressVerdict({ ...RESULTS.organizer, queuedWith: undefined });
    expect(v).toEqual({ kind: "queued", wait: "organizer", holder: null });
  });

  it("a press that threw is refused with nothing named", () => {
    expect(PRESS_THREW).toEqual({ kind: "refused", refusal: undefined });
  });
});

describe("tallyVerdicts — a set's three counts, and the partial that used to vanish", () => {
  it("counts each ending separately and sums to what was dispatched", () => {
    const vs = [RESULTS.applied, RESULTS.applied, RESULTS.applied, RESULTS.organizer, RESULTS.organizer,
      RESULTS.refused, RESULTS.refused].map(pressVerdict);
    const t = tallyVerdicts(vs);
    expect({ applied: t.applied, queued: t.queued, refused: t.refused }).toEqual({ applied: 3, queued: 2, refused: 2 });
    expect(t.applied + t.queued + t.refused).toBe(vs.length);
    expect(t.holder, "the first named holder rides the tally").toBe(QUEUED_HOLDER);
  });

  it("an empty set is four zeros, never a success", () => {
    expect(tallyVerdicts([])).toEqual({ applied: 0, queued: 0, refused: 0, silent: 0, firstRefusal: undefined, holder: null });
  });

  /** A press a newer one replaced is neither done, waiting nor refused — its own count, folded into none. */
  it("a superseded press is silent, and its count is never one of the other three", () => {
    const superseded = { ...RESULTS.applied, status: "superseded" as const };
    expect(pressVerdict(superseded)).toEqual({ kind: "silent" });
    const t = tallyVerdicts([RESULTS.applied, superseded, superseded].map(pressVerdict));
    expect({ applied: t.applied, queued: t.queued, refused: t.refused, silent: t.silent })
      .toEqual({ applied: 1, queued: 0, refused: 0, silent: 2 });
  });

  /** THE DEFECT, AS ARITHMETIC: a count of what applied says 3 over a press of 7. */
  it("what applied is not what was asked for", () => {
    const t = tallyVerdicts([RESULTS.applied, RESULTS.refused, RESULTS.refused].map(pressVerdict));
    expect(t.applied).toBe(1);
    expect(t.refused, "four refusals invisible under a true number").toBe(2);
  });
});
