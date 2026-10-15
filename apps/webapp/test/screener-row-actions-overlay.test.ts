import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A ROW'S QUICK-ADJUST CONTROLS STAND IN A COLUMN OF THEIR OWN — BESIDE THE ROW, NEVER ON IT.
 *
 * The file is named for the mechanism it is about, which it no longer admits: the overlay.
 *
 * Two defects, one rule. First the controls were an in-flow flex SIBLING that reserved a chip's
 * width on every row whether it had controls or not, so every waiting row's preview was cut.
 * The answer then was to float them (`position:absolute`, zero layout width) — and that drew the
 * control ON the subject's tail and the trailing glyphs the moment a row was hovered, reported
 * from use against the Ohbox's "Done" (owner, 2026-09-22).
 *
 * The rule that closes both: the slot is the row's own trailing COLUMN — as wide as the controls
 * it holds, reserved at rest so revealing them shifts nothing, and ZERO where it holds nothing
 * (`.row-actions-in:empty`), which is the first defect's guard. The row button is the other
 * track at `minmax(0,1fr)`, so the subject, the badge strip and the preview clip BEFORE the slot.
 * jsdom lays nothing out, so the geometry itself is measured in a real engine by
 * `row-action-slot-geometry.test.tsx`; these are the source rules that produce it.
 *
 * MUTATION WATCH (2026-09-22): giving `.row-actions` a `position` turns the first case red (and
 * nineteen of the browser test's twenty-three); dropping the `auto` track or the `minmax(0,1fr)`
 * one turns the second red; dropping `.row-actions-in:empty` turns the third. The reachability
 * half fails on the `pointer-events` gating, the focus reveal or the touch arm. A `min-width:0`
 * belt on the row button was measured REDUNDANT here and removed: the track's zero minimum is
 * the button's automatic one, so the heaviest row the language draws still clips at `LIST.min`.
 */

const bare = (p: string): string =>
  readFileSync(resolve(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const rowCss = bare("packages/ui/src/composites/row.css");
const appCss = bare("apps/webapp/app/app.css");

/** Body of the first top-level rule whose selector list starts with `sel` (no nested braces). */
const ruleBody = (css: string, sel: string): string | null => {
  const re = new RegExp(`(?:^|[};])\\s*${sel}\\s*\\{([^{}]*)\\}`, "m");
  const m = re.exec(css);
  return m ? m[1] : null;
};

describe("the controls take a column of their own and the row clips before it", () => {
  it("`.row-actions` is IN FLOW — a position here floats it back over the row's own text", () => {
    const body = ruleBody(rowCss, "\\.row-actions");
    expect(body, "no bare `.row-actions` rule in row.css").not.toBeNull();
    expect(body!, "`.row-actions` is out of flow again — the control lands on the subject")
      .not.toMatch(/position:\s*(absolute|fixed)/);
    expect(body!, "the controls no longer centre on the row").toMatch(/align-items:\s*center/);
  });

  it("`.row-slot` is a two-track grid: the row at `minmax(0,1fr)`, the slot at `auto`", () => {
    const body = ruleBody(rowCss, "\\.row-slot");
    expect(body, "no bare `.row-slot` rule in row.css").not.toBeNull();
    expect(body!, "the slot is not a track of its own any more").toMatch(/display:\s*grid/);
    expect(body!, "the row's track cannot shrink below its content — the slot would be pushed off")
      .toMatch(/grid-template-columns:\s*minmax\(\s*0\s*,\s*1fr\s*\)\s+auto/);
    // The overlay anchored the destination popover here, and it still does.
    expect(body!, "`.row-slot` is not positioned — the row menu has nothing to anchor to")
      .toMatch(/position:\s*relative/);
  });

  it("a row holding no control pays nothing: the empty slot collapses", () => {
    expect(rowCss, "an empty slot still reserves a column — every actionless row loses that width")
      .toMatch(/\.row-actions-in:empty\s*\{[^}]*display:\s*none/);
  });

  it("nothing is painted behind the controls, because nothing of the row is behind them", () => {
    expect(rowCss, "a backdrop is painted in the slot — it can only cover the row beside it")
      .not.toMatch(/linear-gradient/);
  });
});

describe("the controls stay reachable without a pointer, and the empty gutter takes no click", () => {
  it("a hidden control is inert and only opts back in when revealed", () => {
    const base = ruleBody(appCss, "\\.scn-act");
    expect(base, "no bare `.scn-act` rule in app.css").not.toBeNull();
    expect(base!, "a hidden control in the reserved gutter still catches clicks")
      .toMatch(/pointer-events:\s*none/);
    expect(appCss, "revealed controls are never made clickable").toMatch(/pointer-events:\s*auto/);
  });

  it("keyboard focus on the row reveals the controls (not hover-only)", () => {
    expect(appCss, "focus no longer reveals the quick-adjust controls")
      .toMatch(/\.row-slot:focus-within\s+\.scn-act/);
    expect(appCss, "focus no longer reveals the resurfaced row's release")
      .toMatch(/\.row-slot:focus-within\s+\.rsf-done/);
  });

  it("a coarse pointer (touch) gets the controls AND can tap them", () => {
    const media = /@media\s*\(\s*hover:\s*none\s*\)\s*\{([\s\S]*?\.scn-act[\s\S]*?)\}\s*\}/.exec(appCss);
    expect(media, "no `@media (hover: none)` block reveals `.scn-act`").not.toBeNull();
    expect(media![1], "touch shows the controls but leaves them unrevealed visually")
      .toMatch(/opacity:\s*1/);
    expect(media![1], "touch shows the controls but they are not tappable")
      .toMatch(/pointer-events:\s*auto/);
  });
});
