/** @vitest-environment jsdom */
/**
 * THE MAILBOX ROW'S ADDRESS COLUMN, AND THE CAPSULE STANDING IN IT (MBX-ROW-BTN-LABEL-CLIPS-DE).
 *
 * `.mbx-main` is a COLUMN flex, so `align-items` stretches its children to the column's width.
 * The capsule inside it is `white-space: nowrap`. Put those together with a bare
 * `min-width: 120px` and a wide state column beside it, and the button was stretched to 120px and
 * its label cut off mid-word — 26px lost in English on paper, 113px in German on the ohmarchy
 * face, whose font runs wider still.
 *
 * ── WHY THE OBVIOUS TEST WOULD HAVE PASSED THROUGHOUT ─────────────────────────────────────
 *
 * The comparison that suggests itself — "does the button's right edge sit inside the column's?" —
 * is ALWAYS TRUE under `align-items: stretch`, because a stretched button's right edge IS the
 * column's right edge whether or not its label fits. That comparison was measured on this exact
 * row and reported zero while the label was visibly cut. The honest reading is the element's own
 * `scrollWidth − clientWidth`, and it is taken in a browser, where layout exists (the rendered
 * width sweep). What is asserted HERE is the four rules that make the clip unreachable, each with
 * the mutation that brings the clip back.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

/* The suite runs from the repo ROOT, and `pnpm -F` runs from the package — resolve against
   whichever of the two cwd shapes exists, the way `away-notice.test.tsx` does. An absolute path
   built from one of them throws ENOENT from the other, which reads as a broken test rather than
   as a wrong assumption about where it was started. */
const APP = existsSync("apps/webapp/app") ? "apps/webapp/app" : "app";
const app = (): string =>
  readFileSync(`${APP}/app.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The rule whose selector begins a line — the base rule, never a scoped override above it. */
const ruleFor = (src: string, selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\n)${esc}\\s*\\{[^}]*\\}`, "m").exec(src)?.[0].trim() ?? "";
};

describe("the address column floors at its own content, and its capsule is never stretched", () => {
  it("the column's minimum is its CONTENT's, not a fixed 120px", () => {
    /**
     * `min-width: min-content` is what lets the widest control in the column set the floor. A
     * literal here cannot: the widest control is a translated label in a face-dependent font, so
     * any number is right for one locale and one face and wrong for the other three.
     *
     * Mutation that must go red: put `min-width: 120px` back on `.mbx-main`.
     */
    const rule = ruleFor(app(), ".mbx-main");
    expect(rule, "the mailbox row's address column is gone — re-derive this test").not.toBe("");
    expect(rule, "the column floors at a fixed width again, and a wider label is cut")
      .toContain("min-width: min-content");
    expect(rule, "a literal floor is back on the column").not.toMatch(/min-width:\s*\d/);
    // It is still the flexible column of the row, and still a column.
    expect(rule).toContain("flex-direction: column");
    expect(rule).toContain("flex: 1");
  });

  it("a capsule in that column sizes to its LABEL — it is never stretched to the column", () => {
    /**
     * This is the rule that actually stops the clip: `align-self: flex-start` takes the button out
     * of the column's stretch, so its width is its content's. Without it the button is as wide as
     * the column and a `nowrap` label longer than that is cut, whatever the column's floor is.
     *
     * Mutation that must go red: delete this rule.
     */
    expect(ruleFor(app(), ".mbx-main > .mbx-btn"), "the capsule is stretched to the column again")
      .toContain("align-self: flex-start");
  });

  it("the ADDRESS keeps the 120px floor and stays out of the column's minimum", () => {
    /**
     * The address is the one thing in this column that must NOT set the floor: it can be
     * arbitrarily long, and `min-content` on the column would otherwise make the row as wide as
     * the longest address anybody has. `contain: inline-size` keeps it out of that computation —
     * it still ellipsizes at whatever width the column ends up with — and its own `min-width`
     * carries the 120px the column used to.
     *
     * Mutations that must go red: drop `contain: inline-size` (the address rejoins the minimum
     * and the row grows instead of ellipsizing); drop `min-width` (nothing floors the column).
     */
    const rule = ruleFor(app(), ".mbx-addr");
    expect(rule, "the address is back inside the column's minimum width")
      .toContain("contain: inline-size");
    expect(rule, "the 120px floor moved off the address and nothing carries it")
      .toContain("min-width: 120px");
    // And it still ellipsizes rather than wrapping — an address does not break mid-word.
    expect(rule).toContain("text-overflow: ellipsis");
    expect(rule).toContain("white-space: nowrap");
  });

  it("the STATE column is the one that gives the room, and it still wraps", () => {
    // The room has to come from somewhere. The rule of the row is that a capsule's label never
    // wraps and the state column's words do — so the state column is where the give is, which is
    // what its own `flex-wrap` and `min-width: 0` are for. If those went, the address column's
    // new floor would push the row wider instead of taking space from its neighbour.
    const src = app();
    const rule = ruleFor(src, ".mbx-state");
    expect(rule, "the mailbox row's state column is gone — re-derive this test").not.toBe("");
    expect(rule).toContain("min-width: 0");
    expect(rule).toContain("flex-wrap: wrap");
  });

  it("the capsule itself still refuses to wrap — the row's rule, unchanged", () => {
    // The fix is that the COLUMN makes room, not that the label is allowed to break. A wrapped
    // capsule would have been the smaller change and the wrong one.
    expect(ruleFor(app(), ".mbx-btn")).toContain("white-space: nowrap");
  });
});
