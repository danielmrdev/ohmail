import { describe, expect, it } from "vitest";
import { STATISTICS_INGEST_ROWS, createStatisticsUpkeep } from "../src/store-statistics.js";

/**
 * THE LOOK AFTER MAIL COMES IN — drains' changes summed, the store asked once per
 * {@link STATISTICS_INGEST_ROWS}, the count starting again after each look; a failed look never
 * reaches the drain. Watched red: the sum reset per call (case 2 never asks), the reset dropped
 * (case 3 asks on every drain after the first look), the threshold made exclusive (case 1).
 */
describe("the search's statistics after a drain took mail", () => {
  const counting = () => {
    const calls = { n: 0 };
    return { calls, analyze: async () => { calls.n += 1; } };
  };

  it("(1) a drain under the threshold does not ask; one at it asks once", async () => {
    const { calls, analyze } = counting();
    const up = createStatisticsUpkeep(analyze);
    expect(await up.noteIngested(STATISTICS_INGEST_ROWS - 1)).toBe(false);
    expect(calls.n).toBe(0);
    expect(await up.noteIngested(1)).toBe(true);
    expect(calls.n).toBe(1);
  });

  it("(2) small drains add up across drains", async () => {
    const { calls, analyze } = counting();
    const up = createStatisticsUpkeep(analyze, 100);
    for (let i = 0; i < 9; i++) expect(await up.noteIngested(11)).toBe(false);
    expect(await up.noteIngested(11)).toBe(true);
    expect(calls.n).toBe(1);
  });

  it("(3) the count starts again after each look, and a negative count is none", async () => {
    const { calls, analyze } = counting();
    const up = createStatisticsUpkeep(analyze, 100);
    expect(await up.noteIngested(250)).toBe(true);
    expect(await up.noteIngested(-500)).toBe(false);
    expect(await up.noteIngested(99)).toBe(false);
    expect(await up.noteIngested(1)).toBe(true);
    expect(calls.n).toBe(2);
  });

  it("(4) a look that fails is swallowed: the drain's end never throws for it", async () => {
    const up = createStatisticsUpkeep(async () => { throw new Error("analyze refused"); }, 10);
    await expect(up.noteIngested(10)).resolves.toBe(true);
  });
});
