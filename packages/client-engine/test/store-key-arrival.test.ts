import { describe, expect, it } from "vitest";
import { mirrorCoverage, storeInstantOf, storeKeyOf, type StoreTimeline } from "../src/index.js";

/**
 * ONE STORE KEY ON THE CLIENT: `sortAt ?? date`, the epoch when
 * a row has neither — the server's `Dialect.arrivalKey`. The list comparators, the coverage counts
 * and History's walker all read it, so the rows a mirror holds are counted in the months the store
 * pages them in, and a stale-dated arrival is not read as a hole in last year.
 */
describe("the store key", () => {
  it("is the arrival-clamped instant, then the header, then the epoch", () => {
    expect(storeInstantOf({ sortAt: "2026-09-29T08:00:00.000Z", date: "2025-01-01T00:00:00.000Z" }))
      .toBe(Date.parse("2026-09-29T08:00:00.000Z"));
    expect(storeInstantOf({ date: "2025-01-01T00:00:00.000Z" })).toBe(Date.parse("2025-01-01T00:00:00.000Z"));
    expect(storeInstantOf({ date: null })).toBe(0);
    expect(storeKeyOf({ id: "x", date: null })).toEqual({ date: "1970-01-01T00:00:00.000Z", id: "x" });
  });

  it("coverage counts a held row in its ARRIVAL month, the month the store pages it in", () => {
    const t: StoreTimeline = {
      total: 2, undated: 0,
      months: [{ month: "2026-09", count: 2, first: { date: "2026-09-29T08:00:00.000Z", id: "b" } }],
    };
    const held = [
      { id: "a", date: "2026-09-28T08:00:00.000Z" },
      { id: "b", date: "2025-01-01T00:00:00.000Z", sortAt: "2026-09-29T08:00:00.000Z" },
    ];
    expect(mirrorCoverage(t, held), "the stale-dated arrival was counted in 2025").toEqual({ whole: true });
    // CONTROL: one row short of the store's month is a hole below that month's first row.
    expect(mirrorCoverage(t, held.slice(0, 1))).toEqual({ whole: false, below: { date: "2026-09-29T08:00:00.000Z", id: expect.any(String) } });
  });

  it("an undated row is one with no header AND no arrival, counted apart", () => {
    const t: StoreTimeline = { total: 1, undated: 1, months: [] };
    const undated = [{ id: "u", date: null }];
    expect(mirrorCoverage(t, undated)).toEqual({ whole: true });
    const arrivedOnly = [{ id: "v", date: null, sortAt: "2026-09-01T00:00:00.000Z" }];
    expect(mirrorCoverage({ total: 1, undated: 0, months: [{ month: "2026-09", count: 1, first: { date: "2026-09-01T00:00:00.000Z", id: "v" } }] },
      arrivedOnly), "an arrival with no header is dated by it").toEqual({ whole: true });
  });
});
