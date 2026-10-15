import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A SCREENED-OUT SENDER IS A DECIDED ONE, AND ITS ROW HAS TO LOOK DECIDED.
 *
 * The Screener has three segments and only two of them hold mail awaiting a judgement. `waiting`
 * is the queue; `screened` and `spam` are both ALREADY-ANSWERED piles kept viewable so the answer
 * stays reversible. Spam's rows have always said so visually — `MessageRow`'s `dull` drops the
 * sender and subject to `--ink2` at weight 500 (`row.css`) — and the screened-out rows did not.
 *
 * The failure mode is that a row with no `dull` is not a NEUTRAL row: `MessageRow`'s default is
 * the full-strength one (`.row-top .who` at 600, `.row .subj` at `--ink`), which in this product
 * is the language for mail nobody has dealt with yet. So the whole screened-out pile read as
 * unread — every row of it, permanently, because nothing about that pile ever changes the weight.
 * A pile of decisions already taken was the loudest thing in the column.
 *
 * WHAT IS ASSERTED, AND WHY IT IS THE WIRING RATHER THAN A RENDER. `packages/ui` owns whether
 * `dull` draws quiet ink; this file owns which of the three branches HANDS it over, which is a
 * per-branch fact with no visible failure — a branch that forgets the prop renders a completely
 * normal-looking row. Same census, same reason, as `row-stamp-wiring.test.ts`.
 *
 * The three branches are asserted TOGETHER on purpose. Fixing `screened` by sweeping `dull` onto
 * every `MessageRow` in the file would dim the waiting queue too, which is the one pile that must
 * stay loud, and would also flatten `waiting`'s per-sender `dull={w.dull}` into an always-on one.
 *
 * MUTATION WATCH (each applied to `ScreenerView.tsx`, watched go red, reverted):
 *   · `dull` deleted from the screened branch → "the screened-out pile is dimmed".
 *   · `dull` deleted from the spam branch → "spam is still dimmed".
 *   · `dull={w.dull}` in the waiting branch replaced with a bare `dull` → "the waiting queue is
 *     not swept".
 *   · `.srow.dull` rule deleted from `row.css` → "the prop is what quiets the ink".
 */

const src = readFileSync(
  fileURLToPath(new URL("../app/views/ScreenerView.tsx", import.meta.url)),
  "utf8",
);
const rowCss = readFileSync(
  fileURLToPath(new URL("../../../packages/ui/src/composites/row.css", import.meta.url)),
  "utf8",
);

/**
 * The first `<MessageRow …/>` element after `marker`, sliced at its OWN indentation.
 *
 * The indentation is read off the opening tag rather than hard-coded, and the slice ends at the
 * first `/>` sitting at that column — the lesson `row-stamp-wiring.test.ts` records, where a
 * fixed indent ran one element's props on into the next element's and found the string there.
 */
const rowAfter = (marker: string): string => {
  const from = src.indexOf(marker);
  expect(from, `branch marker not found — has ScreenerView been restructured? ${marker}`)
    .toBeGreaterThan(-1);
  const open = src.indexOf("<MessageRow", from);
  expect(open, `no <MessageRow after ${marker}`).toBeGreaterThan(-1);
  const indent = " ".repeat(open - src.lastIndexOf("\n", open) - 1);
  const close = src.indexOf(`\n${indent}/>`, open);
  expect(close, `<MessageRow after ${marker} does not close at its own indentation`)
    .toBeGreaterThan(open);
  /* Comments stripped: these props carry long ones, and every assertion below is about the CODE.
     Left in, prose describing a prop reads as the prop — "the pile read as unread" in the
     screened branch's own comment failed the no-unread-dot case with the wiring correct. */
  return src.slice(open, close).replace(/\/\*[\s\S]*?\*\//g, "");
};

/** An always-on prop: `dull` on its own line, not `dull={…}`. */
const ALWAYS_DULL = /^\s*dull$/m;

describe("the Screener's decided piles are dimmed and its queue is not", () => {
  it("the screened-out pile is dimmed, like the spam pile beside it", () => {
    expect(rowAfter('if (segment === "screened") {')).toMatch(ALWAYS_DULL);
  });

  it("spam is still dimmed", () => {
    expect(rowAfter("const r = x as SpamRow;")).toMatch(ALWAYS_DULL);
  });

  /**
   * The waiting queue keeps the PER-SENDER form. `w.dull` is a property of one sender, not of the
   * pile, so an always-on `dull` here would be a different (and wrong) claim, not a stricter one.
   */
  it("the waiting queue is not swept — its dimming stays per-sender", () => {
    const waiting = rowAfter('if (segment === "waiting") {');
    expect(waiting).toContain("dull={w.dull}");
    expect(waiting).not.toMatch(ALWAYS_DULL);
  });

  /**
   * NOTHING IN THE SCREENED PILE CLAIMS TO BE UNREAD. The rows never carried `unread` — the pile
   * read as unread because the un-dulled default IS the unread-strength row. Wiring an actual
   * unread dot in here later would put the look back with the fix still in place.
   */
  it("no screened-out row claims an unread dot", () => {
    expect(rowAfter('if (segment === "screened") {')).not.toContain("unread");
  });

  /** The prop has to mean something: `dull` is what buys the quiet ink and the lighter weight. */
  it("the prop is what quiets the ink", () => {
    expect(rowCss).toMatch(/\.srow\.dull\s+\.who\s*,\s*\.srow\.dull\s+\.subj\s*\{[^}]*--ink2/);
    expect(rowCss).toMatch(/\.srow\.dull\s+\.who\s*,\s*\.srow\.dull\s+\.subj\s*\{[^}]*font-weight:\s*500/);
  });
});
