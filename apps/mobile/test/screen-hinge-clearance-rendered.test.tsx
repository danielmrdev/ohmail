/** @vitest-environment jsdom */
/**
 * THE SCREEN KEEPS OFF THE CREASE, RENDERED (SCREEN-HINGE-CLEARANCE-HAS-NO-RENDERED-CASE). The law is
 * `screenHingeClearance` and its arithmetic has its own cases; this mounts the real `Screen` from
 * `ui/base` under a book posture and reads the padding its canvas is given, so a Screen that stops
 * asking the law reddens here and not only the typecheck. One pane under a half fold:
 * the content starts past the fold and the keep-out band; flat, it starts past the rail alone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { derivePosture, type FoldFeature } from "../src/ui/posture/derive";
import { mount, styleOf } from "./_rendered-dom";

vi.mock("react-native", async () => (await import("./_rendered-dom")).rnDom);
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }) }));
vi.mock("../src/theme", () => ({ useTheme: () => ({ c: { canvas: "#fff" } }) }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
const live = vi.hoisted(() => ({ posture: null as unknown, win: { width: 0, height: 0 } }));
vi.mock("../src/ui/posture", async () => ({
  ...(await import("../src/ui/posture/derive")),
  usePosture: () => live.posture,
  useAppWindow: () => live.win,
}));

const { Screen } = await import("../src/ui/base");
const { InPaneContext } = await import("../src/ui/pane-chrome");
const { listNavClearance, scaffoldPlan } = await import("../src/ui/scaffold/plan");
/** `plan.ts`'s keep-out band beside a soft crease, as `foldable-book-keeps-off-the-crease` pins it. */
const KEEP_OUT = 8;

const fold = (state: "flat" | "half"): FoldFeature => ({ bounds: { x: 290, y: 0, w: 0, h: 760 }, state, orientation: "vertical", occlusion: "none" });
function pose(state: "flat" | "half") {
  live.posture = derivePosture({ width: 580, height: 760, platform: "android", folds: [fold(state)], hasFold: true });
  live.win = { width: 580, height: 760 };
}
const canvas = (el: HTMLElement) => styleOf(el.querySelector('[data-rn="View"]'));

let open: { unmount(): void } | null = null;
afterEach(() => { open?.unmount(); open = null; });

describe("a Screen under a book fold starts past the crease", () => {
  it("one pane, half open at 290 of 580: the canvas is padded past the fold and its keep-out band", () => {
    pose("half");
    const m = mount(<Screen><span /></Screen>); open = m;
    expect(canvas(m.el).paddingLeft).toBe(290 + KEEP_OUT);
    expect(canvas(m.el).paddingRight).toBe(0);
  });

  it("the control: the same window flat pays only its nav column, which is narrower", () => {
    pose("flat");
    const rail = listNavClearance(scaffoldPlan(live.posture as never, "android"), 0).left;
    const m = mount(<Screen><span /></Screen>); open = m;
    expect(canvas(m.el).paddingLeft).toBe(rail);
    expect(rail).toBeLessThan(290 + KEEP_OUT);
  });

  it("a pane of the pair pays nothing for the crease: the pair splits there", () => {
    pose("half");
    const m = mount(<InPaneContext.Provider value={true}><Screen><span /></Screen></InPaneContext.Provider>); open = m;
    expect(canvas(m.el).paddingLeft).toBe(0);
  });
});
