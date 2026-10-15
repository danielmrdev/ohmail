import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTailProgress, TAIL_PROGRESS_EVERY_MS } from "../src/drain-tail-progress.js";

/**
 * A LONG DRAIN TAIL SAYS SO; A SHORT ONE STAYS SILENT.
 *
 * Both halves are the guard. Silence is what the row is about — the first tail after an import ran
 * fifteen minutes at a third of a core with no line — and noise is what would make the fix worse
 * than the defect, because a settled mailbox's tail runs on every poll of every mailbox.
 */
describe("the drain tail's progress line", () => {
  let lines: Array<{ event: string; fields: Record<string, unknown> }>;
  const log = (event: string, fields: Record<string, unknown>): void => { lines.push({ event, fields }); };

  beforeEach(() => { lines = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("says nothing at all when the tail finishes inside the interval", () => {
    const tail = startTailProgress(log);
    tail.phase("name-repair");
    vi.advanceTimersByTime(TAIL_PROGRESS_EVERY_MS - 1);
    const out = tail.end();
    expect(lines, `a short tail wrote ${lines.length} line(s)`).toHaveLength(0);
    expect(out.lines).toBe(0);
  });

  it("writes a line naming the pass it is inside, and keeps writing while it runs", () => {
    const tail = startTailProgress(log);
    tail.phase("name-repair");
    vi.advanceTimersByTime(TAIL_PROGRESS_EVERY_MS);
    expect(lines, "a tail past the interval wrote nothing").toHaveLength(1);
    expect(lines[0]!.event).toBe("sync_drain_tail_running");
    expect(lines[0]!.fields.phase).toBe("name-repair");
    expect(lines[0]!.fields.totalMs).toBe(TAIL_PROGRESS_EVERY_MS);

    // The pass moves on and the NEXT line says so — a progress line naming the first pass for
    // fifteen minutes is the same silence with more bytes.
    tail.phase("thread-join-heal");
    vi.advanceTimersByTime(TAIL_PROGRESS_EVERY_MS * 2);
    expect(lines).toHaveLength(3);
    expect(lines.slice(1).map((l) => l.fields.phase)).toEqual(["thread-join-heal", "thread-join-heal"]);
    expect(tail.end().lines).toBe(3);
  });

  it("stops when the tail ends, and ending twice is the same as ending once", () => {
    const tail = startTailProgress(log);
    vi.advanceTimersByTime(TAIL_PROGRESS_EVERY_MS);
    const first = tail.end();
    expect(tail.end()).toEqual(first);
    vi.advanceTimersByTime(TAIL_PROGRESS_EVERY_MS * 10);
    expect(lines, "a tail that ended kept writing").toHaveLength(1);
  });

  it("carries only the two fields the log census admits", () => {
    const tail = startTailProgress(log, { everyMs: 10 });
    vi.advanceTimersByTime(10);
    tail.end();
    expect(Object.keys(lines[0]!.fields).sort()).toEqual(["phase", "totalMs"]);
  });
});
