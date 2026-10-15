/**
 * The one-pane list reserves the flying nav's footprint on the nav's own edge — so a side rail
 * never sits over the list's content. Measured on the real iPhone Duo:
 * under the closed-Duo right rail the list ran full width, the dates and the Screener pill's
 * right side clipped under the rail (the content-inset rule / Apple "content should be inset from
 * that edge"). The clearance is a pure function of the plan, driven here through the real
 * posture pipeline exactly as the ActionBar admission is — the component only applies it.
 */
import { describe, expect, it } from "vitest";
import {
  POSTURE_PRESETS,
  derivePosture,
  type PostureOverride,
} from "../src/ui/posture/derive";
import {
  RAIL_W,
  listNavClearance,
  scaffoldPlan,
  type NavClearance,
} from "../src/ui/scaffold/plan";

const DOCK = 96; // theme token space.tabClearance — the caller supplies it

function clearanceFor(presetName: string): { clr: NavClearance; gutter: number } {
  const preset: PostureOverride = POSTURE_PRESETS[presetName]!;
  const platform = preset.platform ?? "ios";
  const posture = derivePosture({
    platform,
    width: preset.width,
    height: preset.height,
    folds: preset.folds ?? null,
    hasFold: preset.hasFold,
    isPad: preset.isPad,
    windowBounds: preset.windowBounds ?? null,
  });
  const plan = scaffoldPlan(posture, platform);
  return { clr: listNavClearance(plan, DOCK), gutter: plan.gutter };
}

describe("the list reserves the flying nav's footprint on its own edge", () => {
  it("the phone dock keeps the footer clear, and neither side", () => {
    const { clr } = clearanceFor("phone");
    expect(clr).toEqual({ bottom: DOCK, left: 0, right: 0 });
  });

  it("the closed Duo's RIGHT rail insets the list from the right, not the bottom", () => {
    const { clr, gutter } = clearanceFor("duo-closed");
    expect(clr).toEqual({ bottom: 0, left: 0, right: RAIL_W + gutter });
    expect(clr.right).toBeGreaterThanOrEqual(RAIL_W); // the rail's own width, at least
  });

  it("a compact-height landscape phone's LEFT rail insets from the left (today's build)", () => {
    const { clr, gutter } = clearanceFor("phone-landscape");
    expect(clr).toEqual({ bottom: 0, left: RAIL_W + gutter, right: 0 });
  });

  it("the split Duo mirrors the inset to the app's outer edge", () => {
    expect(clearanceFor("duo-split-left").clr.left).toBeGreaterThanOrEqual(RAIL_W);
    expect(clearanceFor("duo-split-left").clr.right).toBe(0);
    expect(clearanceFor("duo-split-right").clr.right).toBeGreaterThanOrEqual(RAIL_W);
    expect(clearanceFor("duo-split-right").clr.left).toBe(0);
  });

  it("a two-pane 'bars' surface (iPad, unfolded-portrait Duo) asks for nothing — AppScaffold owns its gutter", () => {
    for (const name of ["ipad", "duo-unfolded-portrait"]) {
      expect(clearanceFor(name).clr, name).toEqual({ bottom: 0, left: 0, right: 0 });
    }
  });

  it("the rail clearance is at least the rail width on every rail posture — no posture leaves content under the rail", () => {
    /* Every posture whose plan is a rail (asserted, not assumed): the clearance covers the rail. */
    for (const name of Object.keys(POSTURE_PRESETS)) {
      const preset = POSTURE_PRESETS[name]!;
      const platform = preset.platform ?? "ios";
      const posture = derivePosture({
        platform, width: preset.width, height: preset.height,
        folds: preset.folds ?? null, hasFold: preset.hasFold,
        isPad: preset.isPad, windowBounds: preset.windowBounds ?? null,
      });
      if (scaffoldPlan(posture, platform).nav !== "rail") continue;
      const { clr } = clearanceFor(name);
      const side = Math.max(clr.left, clr.right);
      expect(side, `${name} rail side`).toBeGreaterThanOrEqual(RAIL_W);
      expect(Math.min(clr.left, clr.right), `${name} inner side`).toBe(0);
    }
  });
});
