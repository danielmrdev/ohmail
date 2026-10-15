/**
 * ═══ THE LAST ROW RESTS CLEAR OF THE FLOATING BARS ═════════════════════════════════════════
 *
 * The dock and the reader's verb bar are glass over the content, with no scrim: mid-scroll the
 * text runs under them by design. At scroll END the last row or paragraph must rest clear: the
 * scroller's foot is the tallest standing bar plus 16 dp (it was 12, the toast's gap).
 */
import { describe, expect, it } from "vitest";
import { CHROME_GAP, listInsets } from "../src/ui/list-insets";

const space = { deckCompact: 12, tabClearance: 96 };

describe("the scroller's foot under a floating bar", () => {
  it("is the bar's extent plus 16 dp", () => {
    expect(CHROME_GAP).toBe(16);
    // The reader's compact bar on the cover, measured at ~136 dp when it wraps to two rows.
    expect(listInsets(space, 24, { bottom: 0, left: 0, right: 0 }, 136).paddingBottom).toBe(152);
  });
  it("under the dock, the larger of the nav's clearance and the dock's reported extent plus 16", () => {
    const dock = { bottom: space.tabClearance, left: 0, right: 0 };
    expect(listInsets(space, 24, dock, 110).paddingBottom).toBe(126);
    expect(listInsets(space, 24, dock, 0).paddingBottom).toBe(120);
  });
});
