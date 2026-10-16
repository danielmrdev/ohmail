import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A LIST'S EMPTY STATE AND EXPLAINER SIT ON THE LIST GUTTER — NOT ON A WIDER INSET OF THEIR OWN.
 *
 * Every list here has one left/right gutter: the header title (`.vhead`, 30px), and every row's
 * text (`.rows` 16px + `.row` 14px = 30px), all land on it. Two blocks used to overshoot it. The
 * explainer note (`.view-note`) ran to a 14px inset — wider than the list it explains, most
 * visible on the full-width single-column views. And the empty state (`.empty`), a child of
 * `.rows` (16px) with the shared 20px of its own, sat at a 36px inset — indented PAST the rows it
 * replaces. Both now share the 30px gutter: the note directly, the empty by matching `.row`'s own
 * 14px inside `.rows`.
 *
 * jsdom lays nothing out, so this is asserted at the source of truth (the stylesheet), the same
 * way `screener-row-actions-overlay.test.ts` and `touch-key-hints.test.ts` assert their geometry,
 * and read with `readFileSync` because this repo's `grep` skips a whole file on one NUL byte.
 *
 * MUTATION WATCH: restore `.view-note` to `0 14px 10px`, or drop the `.rows .empty` rule, or set
 * its inset to anything but `.row`'s 14px, and the matching case turns red.
 */

const bare = (p: string): string =>
  readFileSync(resolve(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const appCss = bare("apps/webapp/app/app.css");
const rowCss = bare("packages/ui/src/composites/row.css");

/** Body of the first top-level rule whose selector list starts with `sel` (no nested braces). */
const ruleBody = (css: string, sel: string): string | null => {
  const re = new RegExp(`(?:^|[};])\\s*${sel}\\s*\\{([^{}]*)\\}`, "m");
  const m = re.exec(css);
  return m ? m[1] : null;
};

/** The single horizontal inset the list uses everywhere — the header/row gutter. */
const GUTTER = 30;

describe("the list gutter is one number, and the empty state and explainer honour it", () => {
  it("`.row` lands its text 14px inside `.rows` — which (with the 16px `.rows`) IS the 30px gutter", () => {
    const row = ruleBody(rowCss, "\\.row");
    expect(row, "no bare `.row` rule in row.css").not.toBeNull();
    // `.row{ … padding:12px 14px … }` — the 14px is the horizontal inset the empty must match.
    const px = /padding:\s*\d+px\s+(\d+)px/.exec(row!);
    expect(px, "`.row` no longer declares a two-value padding").not.toBeNull();
    expect(Number(px![1]), "`.row`'s horizontal inset moved off 14px").toBe(GUTTER - 16);
  });

  it("the explainer note sits on the 30px gutter, not the 14px inset it used to overshoot to", () => {
    const note = ruleBody(appCss, "\\.view-note");
    expect(note, "no bare `.view-note` rule in app.css").not.toBeNull();
    const px = /padding:\s*\d+(?:px)?\s+(\d+)px/.exec(note!);
    expect(px, "`.view-note` no longer declares a horizontal padding").not.toBeNull();
    expect(Number(px![1]), "the explainer ran wider than the list again").toBe(GUTTER);
  });

  it("the empty state carries `.row`'s own 14px inside `.rows`, so its copy is flush with the rows", () => {
    const empty = ruleBody(appCss, "\\.rows\\s+\\.empty");
    expect(empty, "no `.rows .empty` alignment rule in app.css").not.toBeNull();
    expect(empty!, "the empty state's left inset no longer matches the rows").toMatch(
      /padding-left:\s*14px/,
    );
    expect(empty!, "the empty state's right inset no longer matches the rows").toMatch(
      /padding-right:\s*14px/,
    );
  });
});
