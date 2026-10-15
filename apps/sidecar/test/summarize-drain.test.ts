import { describe, expect, it } from "vitest";
import { summarizeDrain } from "../src/engine.js";

/**
 * THE DRAIN SUMMARY — the number that attributes desktop CPU and quit lag.
 *
 * `slowestMs` is the MAX cycle, not the sum: it is the single cycle a quit waits on (the drain
 * checks `stopped` only between cycles, so closing stdin mid-drain still runs the current cycle to
 * the end), and it is the sharpest read on the account-wide-modseq folder-diff. The distinction
 * from `totalMs` is the whole point of the helper — swap the max for a sum and this goes red.
 */
describe("summarizeDrain", () => {
  it("counts cycles, sums total, and reports the SLOWEST (not the total) as the max", () => {
    expect(summarizeDrain([120, 4000, 300])).toEqual({ cycles: 3, totalMs: 4420, slowestMs: 4000 });
  });

  it("a settled mailbox's single cheap cycle is not mistaken for a slow drain", () => {
    expect(summarizeDrain([8])).toEqual({ cycles: 1, totalMs: 8, slowestMs: 8 });
  });

  it("an empty drain is zeroes, never a NaN or a spurious slowest", () => {
    expect(summarizeDrain([])).toEqual({ cycles: 0, totalMs: 0, slowestMs: 0 });
  });
});
