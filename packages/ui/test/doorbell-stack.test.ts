import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE STACK IS A PAPER GESTURE — pinned at the stylesheet, both faces through one rule.
 *
 * Reported on the ringed face: the doorbell's initials ("L P J · 3 waiting") overlapped as square
 * tiles, each wearing a 1px ring, so the tiles read as cut into one another with nothing saying
 * which stood in front. The overlap is right on paper (a fan of circles) and wrong on the ringed
 * face, and the one-UI law forbids saying so with a face selector. So the overlap is a product
 * of the teaching switch — `−7px × (1 − --teach)` — the way the selected row's hop is: −7px under
 * paper (`--teach` 0), and a `+3px × --teach` gap under ohmarchy, a flat row. The "+N" counter goes
 * with the fan by the same product: on the flat row it was a fifth tile beside a sentence that
 * already carries the count.
 *
 * String-level, like `avatar-theme.test.ts`: jsdom computes no `calc()` against a face's tokens;
 * the rendered geometry is `scripts/design-render.mjs`. Mutations watched: drop the `--teach`
 * product from the overlap → red; give the counter a constant width → red; name a face → red.
 */
const css = readFileSync(
  fileURLToPath(new URL("../src/composites/doorbell.css", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const rule = (selector: string): string => {
  const at = css.indexOf(selector + "{");
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open)).replace(/\s+/g, " ");
};

describe("doorbell.css — the fan under paper, a flat row under the ringed face", () => {
  it("the overlap and the gap are one product of --teach", () => {
    expect(rule(".doorbell .avs .av")).toContain(
      "margin-left:calc(-7px * (1 - var(--teach)) + 3px * var(--teach))",
    );
  });

  it("the +N counter's width is the same product — its own 26px under paper, nothing on the flat row", () => {
    const more = rule(".doorbell .avs .av.more");
    expect(more).toContain("max-width:calc(26px * (1 - var(--teach)))");
    expect(more).toContain("margin-left:calc(-7px * (1 - var(--teach)))");
    expect(more).toContain("overflow:hidden");
  });

  it("never names a face", () => {
    expect(css).not.toMatch(/data-face|data-layout/);
  });
});
