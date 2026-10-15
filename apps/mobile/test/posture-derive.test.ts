/**
 * THE POSTURE MODEL, DEVICE BY DEVICE — `derivePosture` driven at every pose the prototype's
 * device table names (there is no React Native renderer in this workspace, so the layout is
 * measurable exactly where it is stated: as data). The presets here are the same objects the
 * OHMAIL_POSTURE override resolves, so a driven simulator's poses and this suite's are one table.
 */
import { describe, expect, it } from "vitest";
import {
  POSTURE_PRESETS,
  derivePosture,
  duoHeuristic,
  heightClassOf,
  parsePostureOverride,
  sizeClassOf,
  windowBoundsOf,
  type PostureInput,
} from "../src/ui/posture/derive";

const of = (name: string, platform: "ios" | "android" = "ios"): PostureInput => {
  const p = POSTURE_PRESETS[name];
  if (!p) throw new Error(`no preset ${name}`);
  return {
    platform: p.platform ?? platform,
    width: p.width,
    height: p.height,
    folds: p.folds ?? null,
    hasFold: p.hasFold,
    isPad: p.isPad,
    windowBounds: p.windowBounds ?? null,
  };
};

describe("size classes are Material's window classes", () => {
  it("width: compact < 600 <= medium < 840 <= expanded", () => {
    expect(sizeClassOf(599)).toBe("compact");
    expect(sizeClassOf(600)).toBe("medium");
    expect(sizeClassOf(839)).toBe("medium");
    expect(sizeClassOf(840)).toBe("expanded");
  });
  it("height: compact < 480 <= medium < 900 <= expanded", () => {
    expect(heightClassOf(479)).toBe("compact");
    expect(heightClassOf(480)).toBe("medium");
    expect(heightClassOf(900)).toBe("expanded");
  });
});

describe("the devices, pose by pose", () => {
  it("phone: compact, one pane, no fold", () => {
    const p = derivePosture(of("phone"));
    expect(p).toMatchObject({ sizeClass: "compact", panes: 1, fold: "none", hinge: null, split: "full", orientation: "portrait", hasFold: false });
  });
  it("duo closed: compact one pane, the hardware fold known while no fold is active", () => {
    const p = derivePosture(of("duo-closed"));
    expect(p).toMatchObject({ sizeClass: "compact", panes: 1, fold: "none", hasFold: true });
  });
  it("duo unfolded landscape: two panes, a flat vertical hinge at the centre", () => {
    const p = derivePosture(of("duo-unfolded"));
    expect(p.panes).toBe(2);
    expect(p.fold).toBe("flat");
    expect(p.orientation).toBe("landscape");
    expect(p.hinge).toEqual({ x: 471, y: 0, w: 9, h: 669 });
  });
  it("duo book: the same hinge, half-open", () => {
    expect(derivePosture(of("duo-book")).fold).toBe("half");
  });
  it("duo tabletop: half-open with the hinge horizontal", () => {
    const p = derivePosture(of("duo-tabletop"));
    expect(p.fold).toBe("half");
    expect(p.hinge !== null && p.hinge.w > p.hinge.h).toBe(true);
  });
  /**
   * THE SIDE COMES FROM THE PLATFORM'S FRAME (FIX-026 row 97). The provider built `{ x: 0, … }`
   * whatever half the window was in, so a right-half split mirrored its rail to the wrong edge.
   * Mutation: answer `x: 0` for a frame and the right-half case reddens.
   */
  it("reads the half from the window's own frame, and falls back to width alone with none", () => {
    const right = windowBoundsOf({ x: 480, w: 471, screenW: 951 }, { width: 471 }, { width: 951 });
    expect(right).toEqual({ x: 480, w: 471, screenW: 951 });
    expect(derivePosture({ ...of("duo-split-right"), windowBounds: right }).split).toBe("right");
    const left = windowBoundsOf({ x: 0, w: 471, screenW: 951 }, { width: 471 }, { width: 951 });
    expect(derivePosture({ ...of("duo-split-right"), windowBounds: left }).split).toBe("left");
    /* A frame as wide as the screen is no split, whatever the width reading says. */
    expect(windowBoundsOf({ x: 0, w: 951, screenW: 951 }, { width: 471 }, { width: 951 })).toBeNull();
    /* No frame (Android, an older build): width alone, the side unknown and left. */
    expect(windowBoundsOf(null, { width: 471 }, { width: 951 })).toEqual({ x: 0, w: 471, screenW: 951 });
    expect(windowBoundsOf(null, { width: 951 }, { width: 951 })).toBeNull();
  });

  it("duo split: one pane on the named half", () => {
    expect(derivePosture(of("duo-split-left")).split).toBe("left");
    expect(derivePosture(of("duo-split-right")).split).toBe("right");
    expect(derivePosture(of("duo-split-left")).panes).toBe(1);
  });
  it("fold inner: android two panes over a flat crease", () => {
    const p = derivePosture(of("fold-inner"));
    expect(p).toMatchObject({ sizeClass: "expanded", panes: 2, fold: "flat", hasFold: true });
  });
  it("the Surface Duo 2's hinge is hard — full occlusion", () => {
    expect(derivePosture(of("sd2")).fold).toBe("hard");
  });
  it("iPad: two panes, no fold anywhere", () => {
    const p = derivePosture(of("ipad"));
    expect(p).toMatchObject({ panes: 2, fold: "none", hasFold: false });
  });
  it("a compact-height landscape phone is one pane", () => {
    expect(derivePosture(of("phone-landscape")).panes).toBe(1);
    expect(derivePosture(of("phone-landscape")).heightClass).toBe("compact");
  });
});

describe("the Duo heuristic answers only where the API is absent", () => {
  it("an iOS window squarer than 1.5:1 with no fold API assumes a centre hinge", () => {
    const p = derivePosture({ platform: "ios", width: 951, height: 669, folds: null });
    expect(p.hinge).not.toBeNull();
    expect(p.fold).toBe("flat");
  });
  it("the API answering 'no folds' ([]) silences the heuristic", () => {
    const p = derivePosture({ platform: "ios", width: 951, height: 669, folds: [] });
    expect(p.hinge).toBeNull();
    expect(p.fold).toBe("none");
  });
  it("a phone shape never matches", () => {
    expect(duoHeuristic(390, 844)).toBeNull();
    expect(duoHeuristic(844, 390)).toBeNull();
  });
  it("an iPad never matches — the size bound and the isPad veto, each alone", () => {
    expect(duoHeuristic(1180, 820)).toBeNull(); // 11": over the 1000 bound
    expect(duoHeuristic(1133, 744)).toBeNull(); // mini: over both bounds
    // a pad windowed to a Duo-like size: the veto answers where the bound cannot
    const p = derivePosture({ platform: "ios", width: 690, height: 920, folds: null, isPad: true });
    expect(p.hinge).toBeNull();
  });
  it("android never guesses — the fold API is the only source there", () => {
    const p = derivePosture({ platform: "android", width: 951, height: 669, folds: null });
    expect(p.hinge).toBeNull();
  });
});

describe("the OHMAIL_POSTURE override", () => {
  it("resolves every preset by name", () => {
    for (const name of Object.keys(POSTURE_PRESETS)) {
      expect(parsePostureOverride(name)).toBe(POSTURE_PRESETS[name]);
    }
  });
  it("takes raw JSON with width and height", () => {
    const o = parsePostureOverride('{"width": 700, "height": 500, "folds": null}');
    expect(o).toMatchObject({ width: 700, height: 500 });
  });
  it("a bad value is null — live wins, never a throw", () => {
    expect(parsePostureOverride("")).toBeNull();
    expect(parsePostureOverride("no-such-pose")).toBeNull();
    expect(parsePostureOverride("{broken")).toBeNull();
    expect(parsePostureOverride('{"height": 500}')).toBeNull();
    expect(parsePostureOverride(null)).toBeNull();
  });
});
