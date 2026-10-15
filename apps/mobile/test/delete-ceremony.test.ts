/**
 * THE DELETE CEREMONY — the DEVICE PATH the review found broken (`runDeleteCeremony`,
 * `state/held-delete.ts`). On the paired iPhone the confirmed delete ran its 8 s window
 * (wire-measured) but the "Moved to Trash." pill with Undo NEVER RENDERED, while Later/Park
 * pills showed reliably. The mechanism: delete was the one verb that navigated the reader away
 * IN THE SAME TICK the window opened (`onDeleted` fired at the press, on the old immediate-
 * tombstone assumption), so the pill's surface was torn down; every other verb keeps the reader.
 *
 * The old verb-undo-live test drove the LIVE arm's `deleteMessage(id, {quiet})` — which has NO
 * window and NO toast — so it measured a different code path than the device runs (the double-
 * that-answers-differently trap). This drives the ceremony the world provider's arm runs, with
 * fake timers, and pins the invariant the fix restores: the navigation belongs to the window's
 * CLOSE, never the press, and never Undo. The render itself (the pill painting over the retained
 * reader) is the the to re-measure; this pins the seam that decides it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeDeleteSession, openDeleteSession, runDeleteCeremony, flushHeldDeletes, heldDeleteIds,
} from "../src/state/held-delete";

/** The account's mirror's client-local half, in memory — the kill test drives the real store. */
function memoryJournal() {
  const rows = new Map<string, unknown>();
  return {
    get: <T,>(type: string, id: string) => rows.get(`${type}:${id}`) as T | undefined,
    commitLocal: async (
      puts: ReadonlyArray<{ type: string; id: string; entity: unknown }>,
      deletes: ReadonlyArray<{ type: string; id: string }>,
    ) => {
      for (const p of puts) rows.set(`${p.type}:${p.id}`, p.entity);
      for (const d of deletes) rows.delete(`${d.type}:${d.id}`);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  /* THE DEVICE PATH HAS A SESSION: the world provider opens the delete window over the mirror. */
  openDeleteSession({ journal: memoryJournal(), dispatch: async () => undefined });
});
afterEach(() => {
  flushHeldDeletes();
  closeDeleteSession();
  vi.useRealTimers();
});

interface Toasted { say: string; undo?: () => void; holdMs?: number }

async function rig(onCommitted?: () => void) {
  const toasts: Toasted[] = [];
  const dispatched: string[] = [];
  const committed: string[] = [];
  await runDeleteCeremony({
    id: "m1",
    windowMs: 8000,
    toast: (say, opts) => toasts.push({ say: String(say), ...(opts ?? {}) }),
    deleted: "Moved to Trash.",
    undone: "Not deleted — the message is where it was.",
    undoLost: "That undo could not be saved — the message is in Trash.",
    dispatchQuiet: () => { dispatched.push("m1"); },
    onCommitted: onCommitted ?? (() => committed.push("m1")),
  });
  return { toasts, dispatched, committed };
}

describe("the pill opens at the press and holds the whole window", () => {
  it('the press enqueues "Moved to Trash." carrying Undo, held for the window', async () => {
    const { toasts } = await rig();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.say).toBe("Moved to Trash.");
    expect(typeof toasts[0]!.undo).toBe("function");
    expect(toasts[0]!.holdMs).toBe(8000);
    // The row is held out of every list the instant the press lands — the pill's whole point.
    expect([...heldDeleteIds()]).toEqual(["m1"]);
  });
});

describe("the navigation belongs to the window's CLOSE, never the press", () => {
  it("nothing navigates and nothing dispatches at the press — the reader stays over the pill", async () => {
    const { dispatched, committed } = await rig();
    // This is the assertion the device defect violated the other way: with the old arm the
    // reader had already navigated by now, killing the pill. Here it has NOT.
    expect(committed).toEqual([]);
    expect(dispatched).toEqual([]);
    expect([...heldDeleteIds()]).toEqual(["m1"]);
  });

  it("the window's close navigates THEN sends — the reader leaves as the delete lands", async () => {
    const order: string[] = [];
    const { dispatched } = await rig(() => order.push("navigate"));
    vi.advanceTimersByTime(8000);
    order.push(...dispatched.map(() => "dispatch"));
    // Navigate first (so the reader unmounts before the tombstone could paint "no longer here"),
    // then the quiet wire send.
    expect(order).toEqual(["navigate", "dispatch"]);
    expect(heldDeleteIds().size).toBe(0);
  });
});

describe("Undo takes the row back and never navigates", () => {
  it("Undo before the window closes: the row returns, nothing sends, nothing navigates", async () => {
    const { toasts, dispatched, committed } = await rig();
    toasts[0]!.undo!();
    // The sentence and the row's return follow the journal's answer (held-delete.ts#undoHeldDelete).
    for (let i = 0; i < 5; i++) await Promise.resolve();
    vi.advanceTimersByTime(10_000);
    // The row is back, no wire send, and — the invariant — the reader did NOT leave.
    expect([...heldDeleteIds()]).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(committed).toEqual([]);
    // The undo spoke its own sentence.
    expect(toasts.map((t) => t.say)).toContain("Not deleted — the message is where it was.");
  });

  it("a late Undo (after the window committed) restores nothing and stays silent", async () => {
    const { toasts, committed } = await rig();
    vi.advanceTimersByTime(8000);
    expect(committed).toEqual(["m1"]);
    const before = toasts.length;
    toasts[0]!.undo!();
    // Nothing restored is not an undo — no extra sentence.
    expect(toasts).toHaveLength(before);
  });
});
