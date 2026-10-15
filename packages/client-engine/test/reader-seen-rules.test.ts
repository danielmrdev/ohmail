import { describe, expect, it } from "vitest";
import { DWELL_MS, EVIDENCE_WINDOW_MS, READING_LINE, atScrollEnd, atScrollTop, dwellCommits } from "../src/index.js";

/**
 * THE DWELL'S DECISION, shared by the web reader and the phone's: the one panel spanning the line,
 * and at the scroll end every panel wholly in view (the end-of-reader rule — a short member after
 * the open message can neither pass nor span the line), and its twin at the scroll TOP: a member
 * wholly above the line there can never pass or span it either. Mutations: the end branch dropped,
 * the wholly-in-view bound widened to partly in view, the top branch read short of the top, the
 * above-the-line bound dropped — each red here.
 */
const view = { top: 0, bottom: 1000, line: 330 };

describe("the shared numbers", () => {
  it("are the ruling's", () => {
    expect([READING_LINE, DWELL_MS, EVIDENCE_WINDOW_MS]).toEqual([0.33, 2000, 1000]);
  });
});

describe("dwellCommits", () => {
  it("short of the end, the one panel spanning the line, never the ones wholly in view below it", () => {
    const panels = [{ id: "a", top: 200, bottom: 600 }, { id: "b", top: 620, bottom: 700 }];
    expect(dwellCommits(panels, view, false, false)).toEqual(["a"]);
  });
  it("at the end, every panel wholly in view as well, in order", () => {
    const panels = [{ id: "a", top: 200, bottom: 600 }, { id: "b", top: 620, bottom: 700 }, { id: "c", top: 720, bottom: 800 }];
    expect(dwellCommits(panels, view, true, false)).toEqual(["a", "b", "c"]);
  });
  it("at the end, a panel cut by the viewport's top is not wholly in view", () => {
    const panels = [{ id: "cut", top: -40, bottom: 200 }, { id: "b", top: 620, bottom: 700 }];
    expect(dwellCommits(panels, view, true, false)).toEqual(["b"]);
  });
  it("nothing spanning and not at the end: nothing", () => {
    expect(dwellCommits([{ id: "b", top: 620, bottom: 700 }], view, false, false)).toEqual([]);
  });
});

describe("dwellCommits at the scroll top (the first-letter twin)", () => {
  const first = [{ id: "first", top: 20, bottom: 254 }, { id: "second", top: 266, bottom: 500 }, { id: "third", top: 512, bottom: 746 }];
  it("at the top, a member wholly above the line is read beside the one spanning it, in order", () => {
    expect(dwellCommits(first, view, false, true)).toEqual(["first", "second"]);
  });
  it("short of the top, the one spanning the line only: the first letter waits", () => {
    expect(dwellCommits(first, view, false, false)).toEqual(["second"]);
  });
  it("at the top, a member wholly in view BELOW the line is not read: it will pass the line", () => {
    expect(dwellCommits(first, view, false, true)).not.toContain("third");
  });
  it("at the top, a member cut by the viewport's top is not wholly in view", () => {
    expect(dwellCommits([{ id: "cut", top: -40, bottom: 200 }], view, false, true)).toEqual([]);
  });
  it("at both the top and the end (a reader that fits), the end's rule decides", () => {
    expect(dwellCommits(first, view, true, true)).toEqual(["first", "second", "third"]);
  });
});

describe("atScrollTop", () => {
  it("is the first pixel of the content, a pixel of rounding included", () => {
    expect(atScrollTop(0)).toBe(true);
    expect(atScrollTop(0.8)).toBe(true);
    expect(atScrollTop(1)).toBe(true);
    expect(atScrollTop(2)).toBe(false);
  });
});

describe("atScrollEnd", () => {
  it("is the last pixel of the content, a pixel of rounding included", () => {
    expect(atScrollEnd(1400, 1000, 2400)).toBe(true);
    expect(atScrollEnd(1399.2, 1000, 2400)).toBe(true);
    expect(atScrollEnd(1398, 1000, 2400)).toBe(false);
  });
});
