import { describe, expect, it } from "vitest";
import { oncePerLaunch } from "../src/once-per-launch.js";

/**
 * THE PRESS REPAIR TRIES ONCE PER LAUNCH, ANSWERED OR FAILED (VERIFY-026 LOW 6): a failure that
 * would not change was retried, and logged, on every drain of the session.
 */
describe("a launch-time repair", () => {
  it("that fails is said once, however many drains ask", async () => {
    let runs = 0;
    const said: unknown[] = [];
    const repair = oncePerLaunch(async () => { runs += 1; throw new Error("store refused"); }, (e) => said.push(e));
    for (let i = 0; i < 5; i++) await repair();
    expect([runs, said.length]).toEqual([1, 1]);
  });

  it("that answers runs once too (the positive control)", async () => {
    let runs = 0;
    const said: unknown[] = [];
    const repair = oncePerLaunch(async () => { runs += 1; }, (e) => said.push(e));
    for (let i = 0; i < 5; i++) await repair();
    expect([runs, said.length]).toEqual([1, 0]);
  });
});
