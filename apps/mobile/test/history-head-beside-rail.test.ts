/**
 * HISTORY'S LIST READS WHOLE BESIDE THE YEAR RAIL. The rail stood over
 * the list's right edge: at 411 dp the head's sentence lost "ne." under it, at font 1.3 "k to",
 * and the rows beside the rail lost their dates — "14 Dec 2019" read "14 Dec 2", previews cut.
 * The head alone keeping the rail clear (the first half) left the rows under it. Now the LIST
 * keeps the rail's measured width clear, head and rows alike, as the webapp's rows do. This
 * suite has no renderer: the geometry is the arithmetic the screen hands the list, over the rail
 * widths a font scale produces, and the wiring that hands it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { HISTORY_HEAD_PAD, HISTORY_RAIL_GAP, HISTORY_RAIL_RIGHT, historyListGutter } from "../src/ui/history-rail";

const SCREEN = withoutComments(readFileSync(fileURLToPath(new URL("../app/history.tsx", import.meta.url)), "utf8"));

describe("the list's content ends before the rail", () => {
  // Screen widths from a small phone to an open fold; rail widths from "2026" at font 1.0 to
  // "Ohne Datum" at font 2.0 with the rail's own padding.
  const screens = [313, 360, 411, 600, 900];
  const rails = [38, 46, 52, 60, 75, 96, 120, 150];
  it("at every width and rail width: the head's words, and a row's date at the list's right edge", () => {
    for (const w of screens) {
      for (const rail of rails) {
        const listEnd = w - historyListGutter(rail);
        const railStart = w - HISTORY_RAIL_RIGHT - rail;
        // A row's date is right-aligned at the list's edge; the head's words end a pad inside it.
        expect(listEnd, `${w} dp screen, ${rail} dp rail: the rows`).toBeLessThanOrEqual(railStart - HISTORY_RAIL_GAP);
        expect(listEnd - HISTORY_HEAD_PAD, `${w} dp screen, ${rail} dp rail: the head`).toBeLessThan(railStart);
      }
    }
  });

  it("control: with no rail, or before it has laid out, the list keeps its full width", () => {
    expect(historyListGutter(null)).toBe(0);
    expect(historyListGutter(0)).toBe(0);
  });
});

describe("the wiring", () => {
  it("the rail reports its width, and the LIST — not the head alone — keeps it clear while the rail stands", () => {
    expect(SCREEN).toMatch(/onLayout=\{\(e\) => setRailWidth\(e\.nativeEvent\.layout\.width\)\}/);
    expect(SCREEN).toContain('<View style={{ flex: 1, paddingRight: historyListGutter(rail ? railWidth : null) }}>');
    expect(SCREEN).toContain("right: HISTORY_RAIL_RIGHT");
    expect(SCREEN).toContain('const rail = h.state === "ready" && h.years.length > 1;');
    // The head keeps its own padding on both sides; the rail's room is the list's.
    expect(SCREEN).toContain("paddingHorizontal: HISTORY_HEAD_PAD, paddingTop: 8, paddingBottom: 4");
    expect(SCREEN).not.toContain("historyHeadPadRight");
  });
  it("the gutter wraps the MailList, so the rows' dates move with the head's words", () => {
    const gutter = SCREEN.indexOf("paddingRight: historyListGutter(");
    const list = SCREEN.indexOf("<MailList");
    const rail = SCREEN.indexOf('accessibilityLabel={Copy.historyRailLabel}');
    expect(gutter).toBeGreaterThan(0);
    expect(list).toBeGreaterThan(gutter);
    expect(rail).toBeGreaterThan(list);
  });
});
