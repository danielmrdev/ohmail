import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DWELL_MS, READING_LINE, SEEN_QUIET_MS, createPhoneReaderSeen } from "../src/ui/reader-seen";
import { EVIDENCE_WINDOW_MS } from "@ohmail/client-engine";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE PHONE READER'S SCROLL-TO-READ, numbers only: the web core's 0.33 line,
 * 2 000 ms dwell and 400 ms batch, over React Native's drag and fling events, in content
 * coordinates. A 1 000 dp viewport puts the line 330 below the offset. Nothing is recorded or
 * marked before the finger drags. Mutations: the drag gate dropped, the line at 1.0, the fling's
 * cancel dropped — each red here.
 */

let seen: string[][] = [];
let read = new Set<string>();
const core = () => createPhoneReaderSeen({ isSeen: (id) => read.has(id), onSeen: (ids) => seen.push(ids) });
beforeEach(() => { vi.useFakeTimers(); seen = []; read = new Set(); });
afterEach(() => { vi.useRealTimers(); });

describe("the numbers", () => {
  it("are the web core's", () => {
    expect([READING_LINE, DWELL_MS, SEEN_QUIET_MS]).toEqual([0.33, 2000, 400]);
  });
});

describe("rule A on the phone", () => {
  it("a drag carrying panel 1's end past the line marks it, once, as one batched glance", () => {
    const c = core();
    c.viewport(1000);
    c.offset("padded", 0);
    c.offset("container", 600);
    c.panel("p1", 0, 300);
    c.panel("p2", 312, 900);
    c.dragBegin();
    c.onScroll(0);
    c.onScroll(400);
    c.onScroll(600);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(SEEN_QUIET_MS);
    expect(seen).toEqual([["p1"]]);
  });

  it("a restored offset with no drag records and marks nothing", () => {
    const c = core();
    c.viewport(1000);
    c.panel("p1", 400, 300);
    c.onScroll(0);
    c.onScroll(2000);
    c.momentumEnd();
    vi.advanceTimersByTime(DWELL_MS * 3);
    expect(seen).toEqual([]);
  });

  it("a panel merely entering the viewport is not read", () => {
    const c = core();
    c.viewport(1000);
    c.panel("p1", 1200, 300);
    c.dragBegin();
    c.onScroll(0);
    c.onScroll(500);
    vi.advanceTimersByTime(SEEN_QUIET_MS);
    expect(seen).toEqual([]);
  });

  it("the panel's top is its own y plus its list's plus the column's", () => {
    const c = core();
    c.viewport(1000);
    c.offset("padded", 18);
    c.offset("container", 200);
    c.panel("p1", 50, 100);
    // top 268, bottom 368: below the line at 0 (330), above it at 39 (369).
    c.dragBegin();
    c.onScroll(0);
    c.onScroll(37);
    vi.advanceTimersByTime(SEEN_QUIET_MS);
    expect(seen).toEqual([]);
    c.onScroll(39);
    vi.advanceTimersByTime(SEEN_QUIET_MS);
    expect(seen).toEqual([["p1"]]);
  });
});

describe("rule B on the phone", () => {
  const tall = () => {
    const c = core();
    c.viewport(1000);
    c.panel("p2", 0, 3000);
    c.dragBegin();
    c.onScroll(100);
    return c;
  };
  it("the finger lifted and a fling begun: no fire", () => {
    const c = tall();
    c.dragEnd();
    c.momentumBegin();
    vi.advanceTimersByTime(DWELL_MS * 2);
    expect(seen).toEqual([]);
  });
  it("the fling ended and 2 000 ms at the line: the panel spanning it", () => {
    const c = tall();
    c.dragEnd();
    c.momentumBegin();
    c.momentumEnd();
    vi.advanceTimersByTime(DWELL_MS - 1);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1 + SEEN_QUIET_MS);
    expect(seen).toEqual([["p2"]]);
  });
  it("a panel read meanwhile is not written again", () => {
    const c = tall();
    c.dragEnd();
    read.add("p2");
    vi.advanceTimersByTime(DWELL_MS + SEEN_QUIET_MS);
    expect(seen).toEqual([]);
  });
  it("leaving the message sends what is pending", () => {
    const c = tall();
    c.dragEnd();
    vi.advanceTimersByTime(DWELL_MS);
    c.dispose();
    expect(seen).toEqual([["p2"]]);
  });
});

describe("the end of the reader (the trailing-members ruling)", () => {
  const trailing = () => {
    const c = core();
    c.viewport(1000);
    c.content(2400);
    c.offset("padded", 0);
    c.offset("container", 1700);
    c.panel("t1", 0, 120);
    c.panel("t2", 132, 120);
    c.panel("t3", 264, 120);
    return c;
  };
  it("short members after the open message are read once the reader rests at its end for the dwell", () => {
    const c = trailing();
    c.dragBegin();
    c.onScroll(0);
    c.onScroll(1400); // 1400 + 1000 = 2400: the end; the line at 1730 never passes t2 or t3
    c.dragEnd();
    vi.advanceTimersByTime(SEEN_QUIET_MS);
    expect(seen, "rule A alone reads none of them").toEqual([]);
    vi.advanceTimersByTime(DWELL_MS);
    expect(seen).toEqual([["t1", "t2", "t3"]]);
  });
  it("short of the end, the dwell reads only the member spanning the line", () => {
    const c = trailing();
    c.dragBegin();
    c.onScroll(0);
    c.onScroll(1200);
    c.dragEnd();
    vi.advanceTimersByTime(DWELL_MS + SEEN_QUIET_MS);
    expect(seen).toEqual([]);
  });
  it("at the end with no drag this open (a restored offset), nothing", () => {
    const c = trailing();
    c.onScroll(1400);
    c.momentumEnd();
    vi.advanceTimersByTime(DWELL_MS * 3);
    expect(seen).toEqual([]);
  });
  it("the app going to the background drops the dwell", () => {
    const c = trailing();
    c.dragBegin();
    c.onScroll(1400);
    c.dragEnd();
    vi.advanceTimersByTime(500);
    c.hidden();
    vi.advanceTimersByTime(DWELL_MS * 2);
    expect(seen).toEqual([]);
  });
});

describe("the top of the reader (the first-letter twin of the end rule)", () => {
  /** A short opened letter, then a member wholly above the line at offset 0: it can never pass it. */
  const leading = () => {
    const c = core();
    c.viewport(1000);
    c.content(3000);
    c.offset("padded", 0);
    c.offset("container", 230);
    c.panel("t1", 30, 60); // 260..320, above the line at 330
    c.panel("t2", 104, 400); // 334..734, below it
    return c;
  };
  it("a member wholly above the line at the top is read once the person's drag rests there for the dwell", () => {
    const c = leading();
    c.dragBegin();
    c.onScroll(200);
    c.onScroll(0);
    c.dragEnd();
    vi.advanceTimersByTime(DWELL_MS - 1 + SEEN_QUIET_MS);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([["t1"]]);
  });
  it("short of the top, it waits", () => {
    const c = leading();
    c.dragBegin();
    c.onScroll(200);
    c.onScroll(2);
    c.dragEnd();
    vi.advanceTimersByTime(DWELL_MS + SEEN_QUIET_MS);
    expect(seen).toEqual([]);
  });
  it("at the top with no drag this open (the open itself, a restored offset), nothing", () => {
    const c = leading();
    c.onScroll(0);
    c.momentumEnd();
    vi.advanceTimersByTime(DWELL_MS * 3);
    expect(seen).toEqual([]);
  });
});

describe("an unevidenced scroll (a screen reader, a restored offset)", () => {
  it("moves the record: a later drag does not commit what it carried past", () => {
    const c = core();
    c.viewport(1000);
    c.panel("p1", 400, 300);
    c.onScroll(0);
    c.onScroll(500); // no drag: p1 passes the line unevidenced
    c.dragBegin();
    c.onScroll(510);
    c.dragEnd();
    vi.advanceTimersByTime(SEEN_QUIET_MS);
    expect(seen).toEqual([]);
  });
  it("drops a running dwell", () => {
    const c = core();
    c.viewport(1000);
    c.panel("tall", 0, 3000);
    c.dragBegin();
    c.onScroll(100);
    c.dragEnd();
    vi.advanceTimersByTime(EVIDENCE_WINDOW_MS + 1); // past the lift's second, inside the dwell
    c.onScroll(110);
    vi.advanceTimersByTime(DWELL_MS + SEEN_QUIET_MS);
    expect(seen).toEqual([]);
  });
});

describe("the evidence window after the finger lifts", () => {
  it("a scroll 1 000 ms after the lift still counts; at 1 001 ms it does not", () => {
    for (const [wait, want] of [[1000, [["p1"]]], [1001, []]] as const) {
      seen = [];
      const c = core();
      c.viewport(1000);
      c.panel("p1", 400, 300);
      c.dragBegin();
      c.onScroll(0);
      c.dragEnd();
      vi.advanceTimersByTime(wait);
      c.onScroll(500);
      vi.advanceTimersByTime(SEEN_QUIET_MS);
      expect(seen, `${wait} ms`).toEqual(want);
      c.dispose();
    }
  });
});

describe("the reader wires the core", () => {
  it("drag, fling, layout and scroll reach it, and the position memory keeps its own line", () => {
    const src = withoutComments(readFileSync(fileURLToPath(new URL("../src/ui/MessageReader.tsx", import.meta.url)), "utf8"));
    for (const needle of [
      "onScrollBeginDrag={seen.dragBegin}", "onScrollEndDrag={seen.dragEnd}",
      "onMomentumScrollBegin={seen.momentumBegin}", "onMomentumScrollEnd={seen.momentumEnd}",
      "recordPaneScroll(scrollKey, e.nativeEvent.contentOffset.y);\n    seen.onScroll(e.nativeEvent.contentOffset.y);",
      'seen.offset("padded", e.nativeEvent.layout.y)', 'seen.offset("container", e.nativeEvent.layout.y)',
      "seen.panel(h.id, e.nativeEvent.layout.y, e.nativeEvent.layout.height)",
      "onContentSizeChange={(_w, h) => seen.content(h)}",
      'if (s !== "active") seen.hidden();',
    ]) expect(src, needle).toContain(needle);
  });
});
