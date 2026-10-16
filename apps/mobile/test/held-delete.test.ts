/**
 * THE DELETE WINDOW'S STORE (`state/held-delete.ts`) — the delayed commit's mechanics, driven
 * with fake timers: the commit fires exactly once (the timer, a flush, whichever first), Undo
 * disarms it and answers whether it took (nothing restored is not an undo), a second press on a
 * held id re-arms nothing, and every change publishes a NEW set — the projection's contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  armHeldDelete, flushHeldDeletes, heldDeleteIds, subscribeHeldDeletes, undoHeldDelete,
} from "../src/state/held-delete";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  // Drain anything a case left armed so no window leaks into the next one.
  flushHeldDeletes();
  vi.useRealTimers();
});

describe("the window commits once, on close", () => {
  it("the timer fires the commit and the held set empties", () => {
    const commits: string[] = [];
    armHeldDelete("m1", 8000, () => commits.push("m1"));
    expect([...heldDeleteIds()]).toEqual(["m1"]);
    expect(commits).toEqual([]);
    vi.advanceTimersByTime(8000);
    expect(commits).toEqual(["m1"]);
    expect(heldDeleteIds().size).toBe(0);
  });

  it("undo inside the window disarms the commit and answers the disk; after it, nothing", async () => {
    const commits: string[] = [];
    armHeldDelete("m1", 8000, () => commits.push("m1"));
    // No session, so no row to remove: the answer is `stored` with nothing to wait for.
    await expect(undoHeldDelete("m1")).resolves.toBe("stored");
    vi.advanceTimersByTime(10_000);
    expect(commits).toEqual([]);
    // The window is gone — a late press restores nothing and must say so.
    expect(undoHeldDelete("m1")).toBeNull();
  });

  it("a second press on a held id re-arms nothing — the first window's promise stands", () => {
    const commits: string[] = [];
    armHeldDelete("m1", 8000, () => commits.push("first"));
    vi.advanceTimersByTime(4000);
    armHeldDelete("m1", 8000, () => commits.push("second"));
    vi.advanceTimersByTime(4000);
    // The FIRST window's clock closed it; the second closure never entered.
    expect(commits).toEqual(["first"]);
  });

  it("flush commits every open window now and clears their timers", () => {
    const commits: string[] = [];
    armHeldDelete("m1", 8000, () => commits.push("m1"));
    armHeldDelete("m2", 8000, () => commits.push("m2"));
    flushHeldDeletes();
    expect(commits.sort()).toEqual(["m1", "m2"]);
    expect(heldDeleteIds().size).toBe(0);
    vi.advanceTimersByTime(10_000);
    // The timers were disarmed with the flush — nothing fires twice.
    expect(commits).toHaveLength(2);
  });
});

describe("the projection's contract", () => {
  it("every change publishes a NEW set to subscribers", () => {
    const seen: ReadonlySet<string>[] = [];
    const off = subscribeHeldDeletes(() => seen.push(heldDeleteIds()));
    armHeldDelete("m1", 8000, () => undefined);
    undoHeldDelete("m1");
    off();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect([...seen[0]!]).toEqual(["m1"]);
    expect(seen[1]!.size).toBe(0);
  });
});

describe("the hiding reader (live.ts#hiddenMessagesReader)", () => {
  const base = {
    version: () => 7,
    stampOf: () => 1,
    stampExcept: () => 1,
    get: <T,>(type: string, id: string): T | undefined =>
      (type === "message" ? ({ id } as unknown as T) : undefined),
    list: <T,>(type: string): T[] =>
      (type === "message" ? ([{ id: "m1" }, { id: "m2" }] as unknown as T[]) : []),
    entries: <T,>(type: string) =>
      (type === "message"
        ? ([{ id: "m1", entity: { id: "m1" } as T, seq: 1 }, { id: "m2", entity: { id: "m2" } as T, seq: 2 }])
        : []),
  };

  it("a held id leaves get, list and entries; everything else passes through", async () => {
    const { hiddenMessagesReader } = await import("../src/state/live");
    const r = hiddenMessagesReader(base as never, new Set(["m1"]));
    expect(r.get("message", "m1")).toBeUndefined();
    expect(r.get("message", "m2")).toEqual({ id: "m2" });
    expect(r.list("message")).toEqual([{ id: "m2" }]);
    expect(r.entries("message").map((e) => e.id)).toEqual(["m2"]);
    // Only messages are a delete's subject — other types pass whole.
    expect(r.list("tag")).toEqual([]);
    expect(r.version()).toBe(7);
  });

  it("identity is preserved when nothing is held — downstream memos keep their inputs", async () => {
    const { hiddenMessagesReader } = await import("../src/state/live");
    expect(hiddenMessagesReader(base as never, new Set())).toBe(base);
  });
});
