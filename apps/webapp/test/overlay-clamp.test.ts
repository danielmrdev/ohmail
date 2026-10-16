import { describe, expect, it } from "vitest";
import {
  OVERLAY_EDGE,
  OVERLAY_GAP,
  OVERLAY_MIN_HEIGHT,
  clampOverlay,
  clampOverlayX,
} from "../app/shell/overlay-clamp";

/**
 * THE OVERLAY GEOMETRY, HELD AS ARITHMETIC.
 *
 * The defect this pins closed: every popover placed by `placePicker` opened downward at a fixed
 * height with `overflow: hidden` and a 190px flip guess, so the ~580px sender sheet anchored to
 * the last message of a thread rendered everything below "Reads" off-screen, and the ~600px
 * screening sheet at 1440×900 clipped "Screened out" and "Spam" out of reach — the re-decide
 * flow was blocked on that path. Page scroll cannot reveal a `position: fixed` box, and the
 * popover variant DISMISSES on scroll, so off-screen meant unreachable, not inconvenient.
 *
 * `clampOverlay` is the pure statement of the fix; `overlay-viewport.test.tsx` holds the wiring
 * (the components actually applying it). The numeric cases below are the sweep's MEASURED
 * geometry, not invented values, so a regression fails on the exact scenario that was filed.
 */

describe("clampOverlay — the three placements", () => {
  it("opens below the anchor when the whole sheet fits there", () => {
    // A short sheet high in the viewport: the placement every caller expects, unchanged.
    const fit = clampOverlay({ y: 108, anchorTop: 80, anchorBottom: 100 }, 190, 900);
    expect(fit.top).toBe(100 + OVERLAY_GAP);
    // The cap is ALWAYS viewport-bound, even when the sheet fits — a confirm opening later
    // grows into a scroll, never off-screen.
    expect(fit.top + fit.maxHeight).toBeLessThanOrEqual(900 - OVERLAY_EDGE);
  });

  it("the measured popover: 583px anchored at 630/654 in a 900px viewport FLIPS above", () => {
    // The sweep's numbers (VWR-1): a 583px popover whose downward placement started at 662 —
    // everything from "Reads" down was off-screen. Above the anchor there is room for the
    // whole sheet, so it flips: bottom edge resting on the anchor's top, fully visible.
    const fit = clampOverlay({ y: 662, anchorTop: 630, anchorBottom: 654 }, 583, 900);
    expect(fit.top).toBe(630 - OVERLAY_GAP - 583);
    expect(fit.top).toBeGreaterThanOrEqual(OVERLAY_EDGE);
    // The whole sheet is on-screen — nothing below the fold.
    expect(fit.top + 583).toBeLessThanOrEqual(900 - OVERLAY_EDGE);
    expect(583).toBeLessThanOrEqual(fit.maxHeight);
  });

  it("TRI-F1's measured sheet: 599px with no room on either side stands WHOLE, slid up over its anchor", () => {
    // The ⋯ → Screening path at 1440×900: the sheet is taller than the space below AND above
    // its anchor, and the viewport holds it with room to spare. It used to take the roomier
    // side capped at ~430px with an inner scroll — "cut off even when plenty of space would be
    // available". Now it keeps its height and slides up from the anchor by exactly the pixels
    // it lacks, covering part of the row it opened from; nothing is clipped and nothing scrolls.
    const fit = clampOverlay({ y: 448, anchorTop: 420, anchorBottom: 440 }, 599, 900);
    expect(fit.maxHeight).toBeGreaterThanOrEqual(599); // whole: no inner scroll
    expect(fit.top).toBe(900 - OVERLAY_EDGE - 599); // slid up by what it lacked below
    expect(fit.top).toBeGreaterThanOrEqual(OVERLAY_EDGE);
    expect(fit.top + 599).toBeLessThanOrEqual(900 - OVERLAY_EDGE);
  });

  it("a sheet taller than the viewport takes the whole band and scrolls inside, whatever the anchor", () => {
    // 1000px of sheet in a 900px viewport: no placement can show it whole, so it takes the
    // viewport's full band — top inset to bottom inset — and the inner scroll is the way through.
    for (const anchor of [
      { y: 858, anchorTop: 830, anchorBottom: 850 },
      { y: 78, anchorTop: 50, anchorBottom: 70 },
      { y: 448, anchorTop: 420, anchorBottom: 440 },
    ]) {
      const fit = clampOverlay(anchor, 1000, 900);
      expect(fit.top).toBe(OVERLAY_EDGE);
      expect(fit.maxHeight).toBe(900 - 2 * OVERLAY_EDGE);
    }
  });

  it("a state without anchor edges (keyboard/synthetic) still stands whole below the point", () => {
    // `placePicker(null)`'s synthetic anchor sits at innerHeight/3; a hand-built state has no
    // edges at all. Both degrade to "below the point, whole" — slid up by the 17px this one
    // lacks — with nothing off-screen and nothing capped.
    const fit = clampOverlay({ y: 308 }, 599, 900);
    expect(fit.top).toBe(900 - OVERLAY_EDGE - 599);
    expect(fit.maxHeight).toBeGreaterThanOrEqual(599);
    expect(fit.top + 599).toBeLessThanOrEqual(900 - OVERLAY_EDGE);
  });

  it("the phone viewport (390×844): a sheet opened low is fully reachable", () => {
    const fit = clampOverlay({ y: 708, anchorTop: 680, anchorBottom: 700 }, 583, 844);
    expect(fit.top).toBeGreaterThanOrEqual(OVERLAY_EDGE);
    expect(fit.top + Math.min(583, fit.maxHeight)).toBeLessThanOrEqual(844 - OVERLAY_EDGE);
  });
});

describe("clampOverlay — the unconditional edges", () => {
  it("never places any part of the sheet off-screen, across a sweep of real geometries", () => {
    // The invariant stated as a sweep rather than cases: for every anchor position, sheet
    // height and viewport that can hold OVERLAY_MIN_HEIGHT at all, the rendered box —
    // min(natural, cap) tall — starts at or below the top edge inset and ends at or above
    // the bottom one. This is the line that goes red if the final clamp is deleted.
    const viewports = [844, 900, 391, 1080];
    const heights = [80, 190, 583, 599, 1400];
    for (const viewport of viewports) {
      for (const natural of heights) {
        for (let aTop = 0; aTop + 24 <= viewport; aTop += 97) {
          const fit = clampOverlay(
            { y: aTop + 24 + OVERLAY_GAP, anchorTop: aTop, anchorBottom: aTop + 24 },
            natural,
            viewport,
          );
          const rendered = Math.min(natural, fit.maxHeight);
          expect(fit.top, `top edge at anchor ${aTop} in ${viewport}`).toBeGreaterThanOrEqual(OVERLAY_EDGE);
          expect(
            fit.top + rendered,
            `bottom edge at anchor ${aTop}, natural ${natural}, viewport ${viewport}`,
          ).toBeLessThanOrEqual(viewport - OVERLAY_EDGE);
        }
      }
    }
  });

  it("the cap never collapses below the usable minimum, even mid-anchor on a 240px viewport", () => {
    // A short landscape keyboard-up viewport with the anchor mid-screen: both sides offer less
    // than the minimum. The floor wins — the sheet may then cover its anchor, which is the
    // correct last resort: a covered anchor is dismissable, a 90px slit of destinations is not.
    const fit = clampOverlay({ y: 142, anchorTop: 110, anchorBottom: 134 }, 599, 240);
    expect(fit.maxHeight).toBeGreaterThanOrEqual(OVERLAY_MIN_HEIGHT);
    // And the floored box still sits inside the viewport.
    expect(fit.top).toBeGreaterThanOrEqual(OVERLAY_EDGE);
    expect(fit.top + fit.maxHeight).toBeLessThanOrEqual(240 - OVERLAY_EDGE);
  });
});

describe("clampOverlayX — the horizontal half, against the measured width", () => {
  it("pulls a right-flush anchor back on-screen for the sheet's REAL 252px, not the 240 guess", () => {
    // `placePicker` clamps x for its own 240px estimate; the sender sheet is 252px wide, so an
    // anchor at the right edge clipped 12px of it. The clamp against the measured width holds.
    const x = clampOverlayX(1440 - 240 - OVERLAY_EDGE, 252, 1440);
    expect(x + 252).toBeLessThanOrEqual(1440 - OVERLAY_EDGE);
  });

  it("never pushes the box past the left inset", () => {
    expect(clampOverlayX(-40, 252, 390)).toBe(OVERLAY_EDGE);
  });
});
