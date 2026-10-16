import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE FOCUSED TILE'S RING — pinned at the stylesheet, both faces through one rule set.
 *
 * Owner report on the ohmarchy face: arrow navigation across the three columns showed no
 * focused column ("the middle column gets absolutely no highlight around the edge"). The
 * remedy lives in `zone-cursor.css`: every tile the zone model can land on restates its
 * resting shadow with an accent ring painted first, whose width is `--focus-w × --teach` —
 * zero under paper (teaching intensity 0, so paper's quiet cues stay exactly as they were)
 * and 2px under ohmarchy, where it replaces Hyprland's inactive 2px ring with the active one.
 *
 * Pinned here rather than in a rendered walk because jsdom computes no `calc()` against a
 * face's tokens; the keyboard walkthrough asserts the rendered ring on a real Chromium
 * (`scripts/ux-suite`). Mutations watched: dropping `var(--teach)` from the product (paper
 * would grow a ring) → red; dropping a tile's selector → red; naming a face in a selector
 * (`[data-face=…]`, a fork the one-UI census also forbids here) → red.
 */
const CSS = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/zone-cursor.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const RING = "0 0 0 calc(var(--focus-w) * var(--teach)) var(--focus, var(--accent))";

/** The declarations of the block whose selector list contains `selector`. */
function blockOf(selector: string): string {
  const at = CSS.indexOf(selector);
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  const open = CSS.indexOf("{", at);
  return CSS.slice(open + 1, CSS.indexOf("}", open)).replace(/\s+/g, " ");
}

describe("zone-cursor.css — the focused tile wears the ring, in every tile the zone model reaches", () => {
  for (const tile of [
    ':root[data-zone="rail"] .deck > .rail',
    ':root[data-zone="list"] .view .list-col',
    ':root[data-zone="reader"] .view .read-col:not(:has(> .conv))',
    ':root[data-zone="reader"] .view-settings .set-pane',
  ]) {
    it(`${tile}: the ring is the first shadow and its width is --focus-w × --teach`, () => {
      const block = blockOf(tile);
      expect(block).toContain("box-shadow:");
      // First in the list = painted on top; under ohmarchy it must cover the 2px inactive ring.
      expect(block.indexOf(RING)).toBe(block.indexOf("box-shadow:") + "box-shadow: ".length);
      // The resting shadow is restated, so paper's tile keeps its lift and ohmarchy its border.
      expect(block).toContain("var(--lift-1)");
    });
  }

  it("a thread column, which has no tile, draws the ring as an outline at the tile's edge", () => {
    const block = blockOf(':root[data-zone="reader"] .view .read-col:has(> .conv)');
    expect(block).toContain("outline: calc(var(--focus-w) * var(--teach)) solid var(--focus, var(--accent))");
    expect(block).toContain("outline-offset: calc(-1 * var(--gap-edge))");
  });

  it("never names a face — the ring is a token product, not a fork", () => {
    expect(CSS).not.toMatch(/data-face|data-layout/);
  });

  it("paper's quiet cues survive beside the ring (the rail bar, the reader hairline)", () => {
    expect(blockOf(':root[data-zone="rail"] .deck > .rail')).toContain("inset 2px 0 0 var(--accent-soft)");
    expect(blockOf(':root[data-zone="reader"] .view .read-col:not(:has(> .conv))')).toContain("inset 0 0 0 1px var(--accent-soft)");
  });
});

/**
 * THE RING'S ROOM — pinned at the two stylesheets that give an outer ring the pixels it paints in.
 *
 * Owner report (macOS, the ohmarchy face): the compose card, the settings pane and a selected
 * first row drew left, right and bottom edges and NO top edge. The ring is an OUTER box-shadow
 * spread (`--lift-*` under ohmarchy is `0 0 0 2px …`), painted outside the box, and a scrollport
 * clips at its padding edge — so a ringed surface flush at a scroller's top lost exactly the
 * rows the ring lives in, while the sides stood in the 16px `.rows` gutter and the foot in the
 * scroller's 48px reserve. The remedy is geometry in tokens: every `.scroller` reserves the
 * ring's own width at its top as the SAME product the tile ring is built from — zero under
 * paper (nothing moves), 2px under ohmarchy — and the selected row's 1px lift, paper's raised-
 * object gesture, is multiplied away by the teaching switch so the room is exactly the ring.
 * Rendered proof is `scripts/face-edges-render.mjs` (real Chromium, every ringed box, four edges).
 * Mutations watched: the padding dropped → red; the product replaced by a literal → red; the
 * hop restored to `-1px` → red.
 */
describe("the ring has room — a scroller reserves the ring's width at its top, and the row stops hopping under it", () => {
  const LIST_PANE = readFileSync(resolve(process.cwd(), "packages/ui/src/composites/list-pane.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const ROW = readFileSync(resolve(process.cwd(), "packages/ui/src/composites/row.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const ROOM = "calc(var(--focus-w) * var(--teach))";

  it(".scroller: padding-top is the ring product, not a literal", () => {
    const m = /\.scroller\s*\{([^}]*)\}/.exec(LIST_PANE);
    expect(m, "no `.scroller` rule in list-pane.css").not.toBeNull();
    const body = m![1]!.replace(/\s+/g, " ");
    expect(body).toContain(`padding-top:${ROOM}`);
    expect(body).toContain("overflow-y:auto");
  });

  it(".row.sel: the lift is paper's — `(1 - --teach)` zeroes it where the face rings", () => {
    /* EVERY rule that styles the selected row, not the first one spelled `.row.sel{`. A row with
       a trailing action slot wears its surface on the slot, so the lift moved to a selector list
       (`.row.sel,.row-slot:has(.row.sel)`) and a second rule now cancels it on the button inside
       a slot — a first-match read found the canceller and reported the lift gone. */
    const rules = [...ROW.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => /\.row\.sel(?![\w-])/.test(m[1]!));
    expect(rules.length, "no rule in row.css styles `.row.sel`").toBeGreaterThan(0);
    const lifts = rules
      .map((m) => m[2]!.replace(/\s+/g, " "))
      .filter((b) => /transform:\s*translateY/.test(b));
    expect(lifts.length, "the selected row's lift is declared in no rule, or in more than one")
      .toBe(1);
    expect(lifts[0]!).toContain("transform:translateY(calc(-1px * (1 - var(--teach))))");
    expect(ROW).not.toMatch(/translateY\(-1px\)/);
  });

  it("neither sheet names a face — the room is a token product, not a fork", () => {
    expect(LIST_PANE).not.toMatch(/data-face|data-layout/);
    expect(ROW).not.toMatch(/data-face|data-layout/);
  });
});
