/**
 * BOOK POSTURE KEEPS EVERYTHING OFF THE CREASE, as the laws `derive.ts` and
 * `scaffold/plan.ts` state them. A separating vertical fold splits the window at the hinge whatever
 * the Android width floor says while each side holds a pane; below that the one pane is confined to
 * one side, its navigation is the leading rail (never a dock across the crease), and a sheet takes
 * the reading side. A flat fold has no width and changes nothing.
 */
import { describe, expect, it } from "vitest";
import {
  ANDROID_TWO_PANE_MIN, BOOK_SIDE_MIN, derivePosture, separatingVerticalHinge, type FoldFeature,
} from "../src/ui/posture/derive";
import {
  pairBoxOf, pairPadding, pairSlots, scaffoldPlan, screenHingeClearance,
} from "../src/ui/scaffold/plan";
import { sheetPanelBounds } from "../src/ui/sheet-bounds";

const fold = (x: number, h: number, state: "flat" | "half", occlusion: "none" | "full" = "none", w = 0): FoldFeature =>
  ({ bounds: { x, y: 0, w, h }, state, orientation: "vertical", occlusion });
const android = (width: number, height: number, folds: FoldFeature[]) =>
  derivePosture({ width, height, platform: "android", folds, hasFold: true });

describe("a book fold splits at the hinge under the width floor", () => {
  it("the Galaxy Z Fold inner panel (674 dp) in book posture holds two panes; flat it keeps the floor", () => {
    expect(674).toBeLessThan(ANDROID_TWO_PANE_MIN);
    expect(android(674, 841, [fold(337, 841, "half")]).panes).toBe(2);
    expect(android(674, 841, [fold(337, 841, "flat")]).panes, "a flat fold has no width: the floor stands").toBe(1);
    expect(android(674, 841, []).panes).toBe(1);
  });

  it("a hardware hinge separates like a half fold", () => {
    expect(android(674, 841, [fold(320, 841, "flat", "full", 34)]).panes).toBe(2);
  });

  it("each side must hold a pane: a side under the book floor keeps one pane", () => {
    expect(android(2 * BOOK_SIDE_MIN, 841, [fold(BOOK_SIDE_MIN, 841, "half")]).panes).toBe(2);
    expect(android(2 * BOOK_SIDE_MIN - 20, 841, [fold(BOOK_SIDE_MIN - 10, 841, "half")]).panes).toBe(1);
  });

  for (const [w, h] of [[674, 841], [718, 897], [616, 770]] as const) {
    it(`${w} x ${h}: the list ends before the crease and the reader starts past it`, () => {
      const p = android(w, h, [fold(w / 2, h, "half")]);
      const plan = scaffoldPlan(p, "android");
      const s = pairSlots(p, plan, pairBoxOf({ w, h }, { left: 0, right: 0 }), "pair", null);
      const listRight = pairPadding(plan).left + (s.list.width as number);
      expect(listRight).toBeLessThanOrEqual(w / 2);
      expect(listRight + (s.seam.width as number)).toBeGreaterThanOrEqual(w / 2);
    });
  }
});

describe("one pane under a book fold is confined to one side", () => {
  const p = android(580, 760, [fold(290, 760, "half")]);
  const plan = scaffoldPlan(p, "android");

  it("the navigation is the leading rail, never the dock laid across the crease", () => {
    expect(p.panes).toBe(1);
    expect(plan.nav).toBe("rail");
    expect(plan.navSide).toBe("left");
  });

  it("a screen that fills the window starts past the keep-out band", () => {
    expect(screenHingeClearance(p, plan, true, false, 580)).toEqual({ left: 290 + 8, right: 0 });
    expect(screenHingeClearance(p, plan, true, true, 580), "a pane of the pair pays nothing").toEqual({ left: 0, right: 0 });
    expect(screenHingeClearance(p, plan, false, false, 580), "the pair splits; it is not confined").toEqual({ left: 0, right: 0 });
  });

  it("a right rail confines to the left side instead", () => {
    expect(screenHingeClearance(p, { navSide: "right" }, true, false, 580)).toEqual({ left: 0, right: 290 + 8 });
  });

  it("a flat fold confines nothing", () => {
    const flat = android(580, 760, [fold(290, 760, "flat")]);
    expect(separatingVerticalHinge(flat.fold, flat.hinge)).toBeNull();
    expect(screenHingeClearance(flat, scaffoldPlan(flat, "android"), true, false, 580)).toEqual({ left: 0, right: 0 });
  });

  it("a sheet takes the reading side and never reaches back over the crease", () => {
    const b = sheetPanelBounds(580, 760, 24, null, p.hinge);
    expect(b.alignSelf).toBe("flex-end");
    expect(b.width).toBe(290);
  });
});
