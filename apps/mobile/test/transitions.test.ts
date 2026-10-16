/**
 * THE TRANSITION GATE (a review finding: serialize overlapping connection transitions).
 *
 * Two profile taps overlapping, or a switch racing the launch connect, must never yield two
 * live sessions. (The second presenter of one refresh token is closed apart from this, by one
 * manager per slot in `bearer-registry.ts`.) The gate gives the connection layer both halves:
 *
 *  · **serialization** — transitions run one at a time, each behind the previous, so two
 *    boots' probes can never rotate the same token concurrently;
 *  · **last-wins supersession** — a transition requested while an earlier one is queued or
 *    running marks the earlier one stale via its `stillCurrent()`, so the stale outcome is
 *    torn down instead of adopted.
 */
import { describe, expect, it } from "vitest";
import { TransitionGate } from "../src/net/transitions";

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("the transition gate", () => {
  it("runs transitions strictly one at a time, in request order", async () => {
    const gate = new TransitionGate();
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const op = (n: number) =>
      gate.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await tick(10);
        order.push(n);
        active--;
        return n;
      });
    const [a, b, c] = await Promise.all([op(1), op(2), op(3)]);
    expect([a, b, c]).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
    // ONE at a time — the property that stops two managers presenting one refresh token.
    expect(peak).toBe(1);
  });

  it("a newer request supersedes an older one — stillCurrent() flips, the last stays true", async () => {
    const gate = new TransitionGate();
    const endedCurrent: Array<[number, boolean]> = [];
    const op = (n: number) =>
      gate.run(async (stillCurrent) => {
        await tick(5);
        endedCurrent.push([n, stillCurrent()]);
      });
    const first = op(1);
    const second = op(2); // requested while 1 is running: 1 is stale from this moment
    await Promise.all([first, second]);
    expect(endedCurrent).toEqual([
      [1, false], // superseded — its outcome must be torn down, never adopted
      [2, true], // the user's last word wins
    ]);
  });

  it("a transition that throws neither blocks nor un-supersedes the queue behind it", async () => {
    const gate = new TransitionGate();
    const boom = gate.run(async () => {
      throw new Error("mid-transition failure");
    });
    await expect(boom).rejects.toThrow(/mid-transition/);
    const after = await gate.run(async (stillCurrent) => stillCurrent());
    expect(after).toBe(true);
  });
});
