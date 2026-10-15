/**
 * ONE INSET RULE FOR BOTH LIST PRIMITIVES. `Scroller` (the flow screens) and `MailList` (the mail
 * lists) must pay the same side gutter and the same clearance under the flying nav plus the OS
 * bottom inset, or a list screen and a settings screen disagree about where content ends under
 * the dock. The rule is one function, `listInsets`, driven here at three postures' bottom insets;
 * both primitives are then read for calling the ONE hook over it and spreading its result, never
 * a spelling of their own. No RN renderer here, so the equality is proved by construction: one
 * function, two call sites, and a census that no other list file spells the clearance token.
 * Mutations: drop `paddingBottom` from `listInsets` (arithmetic); drop the chrome arm; a content style of MailList's own.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { CHROME_GAP, listInsets } from "../src/ui/list-insets";
import { space } from "../src/theme/tokens";

const UI = fileURLToPath(new URL("../src/ui", import.meta.url));
const APP = fileURLToPath(new URL("../app", import.meta.url));
const read = (p: string) => withoutComments(readFileSync(p, "utf8"));
const base = read(join(UI, "base.tsx"));
const mailList = read(join(UI, "MailList.tsx"));

/**
 * The three postures the brief names: the bottom inset each hands the hook, and what the flying
 * nav leaves beside it. A rail takes a SIDE and nothing at the foot; a dock takes the foot and
 * neither side — so a list under a rail may not run beneath it, and one under a dock may not end
 * beneath that. `listNavClearance` is where the plan states this; the arithmetic is asked here.
 */
const POSTURES = {
  closedFoldableRail: { bottom: 0, nav: { bottom: 0, left: 0, right: 64 } },
  landscapeCompact: { bottom: 21, nav: { bottom: 0, left: 64, right: 0 } },
  dock: { bottom: 34, nav: { bottom: space.tabClearance, left: 0, right: 0 } },
} as const;

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("the arithmetic, at three postures", () => {
  for (const [posture, { bottom, nav }] of Object.entries(POSTURES)) {
    it(`${posture}: each gutter is the deck's, the foot the nav's plus the inset`, () => {
      const got = listInsets(space, bottom, nav);
      expect(got).toEqual({
        paddingLeft: space.deckCompact,
        paddingRight: space.deckCompact,
        paddingBottom: nav.bottom + bottom,
      });
      // A rail's list keeps the OS inset at the foot; a dock's keeps the dock's clearance too.
      expect(got.paddingBottom, "the foot never falls below what the nav asked for")
        .toBeGreaterThanOrEqual(nav.bottom);
    });
  }

  it("the foot clears the tallest chrome standing there, plus the gap, when that reaches higher", () => {
    const { bottom, nav } = POSTURES.dock;
    expect(listInsets(space, bottom, nav, 140).paddingBottom).toBe(140 + CHROME_GAP);
    expect(listInsets(space, bottom, nav, 20).paddingBottom, "a low chrome leaves the nav's own foot").toBe(nav.bottom + bottom);
    expect(listInsets(space, bottom, nav, 0).paddingBottom).toBe(nav.bottom + bottom);
  });

  it("a rail's side is paid by Screen: every screen on a one-pane rail, a full-window one beside a two-pane rail", () => {
    const at = base.indexOf("export function Screen(");
    const body = base.slice(at, base.indexOf("\n}\n", at));
    expect(body).toContain("const rail = screenRailClearance(plan, fills, inPane, useNavDrawn());");
    expect(body).toContain("const side = screenSideInsets(insets, inPane);");
    expect(body).toContain("paddingLeft: Math.max(side.left + rail.left, hinge.left),");
    expect(body).toContain("paddingRight: Math.max(side.right + rail.right, hinge.right),");
  });
});

describe("both primitives read the one hook", () => {
  it("the hook is defined once, over the theme's space and the live bottom inset", () => {
    expect(base).toContain("export function useListInsets(): ListInsets {");
    expect(base).toContain(
      "return listInsets(t.space, useSafeAreaInsets().bottom, listNavClearance(plan, t.space.tabClearance, useNavDrawn()), useBottomChromeExtent());",
    );
    // …over the plan the posture answers, so the rail's side is in the arithmetic and not guessed.
    expect(base).toContain("const plan = scaffoldPlan(usePosture(), Platform.OS === \"ios\" ? \"ios\" : \"android\");");
    expect(base.match(/function useListInsets/g)).toHaveLength(1);
  });

  it("Scroller spreads the hook's result first in its content style", () => {
    const at = base.indexOf("export function Scroller(");
    expect(at).toBeGreaterThan(-1);
    const body = base.slice(at, base.indexOf("\n}\n", at));
    expect(body).toContain("const insets = useListInsets();");
    expect(body).toMatch(/contentContainerStyle=\{\[\s*insets,/);
    expect(body, "no inset of its own").not.toMatch(/paddingBottom|paddingHorizontal|tabClearance|deckCompact/);
  });

  it("MailList hands the hook's result as its whole content style", () => {
    expect(mailList).toContain("const insets = useListInsets();");
    expect(mailList).toContain("contentContainerStyle={insets}");
    expect(mailList, "no inset of its own").not.toMatch(/tabClearance|deckCompact|insets\.bottom/);
    // The surface it paints sits inside the same gutter and ends above the same clearance.
    expect(mailList).toContain("left: insets.paddingLeft");
    expect(mailList).toContain("right: insets.paddingRight");
    expect(mailList).toContain("bottom: insets.paddingBottom + tailH");
  });

  it("no list file under ui/ or app/ spells the clearance token itself", () => {
    const spellers: string[] = [];
    for (const path of [...files(UI), ...files(APP)]) {
      const rel = relative(UI, path);
      /* `list-insets.ts` IS the rule. `base.tsx` holds the one hook, which hands the token to the
         plan's own reader and does no arithmetic with it — asserted below rather than waved
         through, so an inset spelled there still refuses. */
      if (rel === "list-insets.ts" || rel === "base.tsx") continue;
      if (/\btabClearance\b/.test(read(path))) spellers.push(rel);
    }
    expect(spellers).toEqual([]);
  });

  it("the hook names the clearance token only to hand it to the plan's reader", () => {
    const uses = [...base.matchAll(/\btabClearance\b/g)];
    expect(uses.length, "one use, in the one hook").toBe(1);
    const at = uses[0]!.index!;
    expect(
      base.slice(Math.max(0, at - 60), at + 40),
      "the token reaches listNavClearance and nothing else",
    ).toContain("listNavClearance(plan, t.space.tabClearance, useNavDrawn())");
  });
});
