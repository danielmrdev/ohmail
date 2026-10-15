import { describe, expect, it } from "vitest";
import { countWhen, listSurface, waitingSurfaceInput, type WaitingSurfaceFacts } from "../src/index.js";

/**
 * THE WAITING LIST'S OWN READING (`waitingSurfaceInput`). The store's queue is exact whatever this
 * device has taken in: only the account's own open import withholds it, and a store counting
 * senders the list has no rows for is never stated empty. Every other source reads as any list.
 */

const store = (over: Partial<WaitingSurfaceFacts>): WaitingSurfaceFacts => ({
  source: "store", storeTotal: 0, queueAnswered: true, settled: false, owed: true, storeImportOpen: false, count: 0,
  ...over,
});

describe("waitingSurfaceInput", () => {
  it("a store that answered zero with its import closed is empty, whatever this device owes", () => {
    const input = waitingSurfaceInput(store({}));
    expect(listSurface(input)).toBe("empty");
    expect(countWhen(input, "meta")).toBe("meta");
  });

  it("a store counting senders the list has no rows for withholds the empty state", () => {
    const input = waitingSurfaceInput(store({ storeTotal: 3, owed: false, settled: true }));
    expect(listSurface(input)).toBe("pending");
  });

  it("…and with rows on screen its exact count is still stated", () => {
    const input = waitingSurfaceInput(store({ storeTotal: 3, count: 2 }));
    expect(listSurface(input)).toBe("content");
    expect(countWhen(input, "meta")).toBe("meta");
  });

  it("the account's own open import withholds the list and its count", () => {
    const input = waitingSurfaceInput(store({ storeImportOpen: true, owed: false, settled: true }));
    expect(listSurface(input)).toBe("pending");
    expect(countWhen(input, "meta")).toBeUndefined();
  });

  it("a store whose page is not in the mirror, and the device's own derivation, read as any list", () => {
    for (const facts of [store({ queueAnswered: false }), store({ source: "device" }), store({ source: "local" })]) {
      expect(waitingSurfaceInput(facts)).toEqual({ settled: facts.settled, count: facts.count, pending: facts.owed, why: "importing" });
    }
    expect(waitingSurfaceInput(store({ source: "device", owed: false })).why).toBeNull();
  });

  it("names why it withholds: an open import, or senders this device has already filed", () => {
    expect(waitingSurfaceInput(store({ storeImportOpen: true, storeTotal: 3 })).why).toBe("importing");
    expect(waitingSurfaceInput(store({ storeTotal: 3 })).why).toBe("listing");
    expect(waitingSurfaceInput(store({ storeTotal: 3, count: 2 })).why).toBeNull();
    expect(waitingSurfaceInput(store({})).why).toBeNull();
  });
});
