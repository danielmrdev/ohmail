import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A PILE TITLE IS ONE SIZE, EVERYWHERE.
 *
 * "Ohbox", "Reads", "Receipts", "Screener", a tag's name — every one of them is the same kind of
 * word in the same slot at the top of the list column, and every one of them was set two ways:
 * 26px from `list-pane.css`, dropping to 22px under the webapp's phone block, with
 * the mobile stream header (`.stream-top h1`, the same title on the Reads and Receipts streams)
 * carrying its own third declaration. At the desktop size the result was a title noticeably
 * heavier than the list it names — the pile label reading as a page heading.
 *
 * It is now 20px, declared ONCE, and this file's job is to keep it single-valued rather than to
 * bless a particular number twice. Every rule in either stylesheet that sizes a pile title is
 * collected — media blocks included, which is what makes the 390px case a consequence of the
 * assertion rather than a second assertion — and the set of sizes has to have exactly one member.
 *
 * BLANC. The prototype (`design/proposals/blanc/index.html`, lines 257 and 780) says 26px/22px and this is a
 * deliberate departure from it, made because the titles were called out as too large in the
 * running app. It is not gated: the tokens' fidelity guard, private because it reads the prototype,
 * pins the prototype's CUSTOM PROPERTIES against `tokens.css`, and a composite's px values are outside it.
 *
 * MUTATION WATCH (each applied, watched go red, reverted):
 *   · `.vhead h1` restored to 26px → the base case and the single-value case.
 *   · `.view .vhead h1 { font-size: 22px }` put back in the phone block → the single-value case.
 *   · `.stream-top h1` restored to 22px → its own case and the single-value case.
 */

/** Comments stripped first — a commented-out declaration is not a declaration. */
const bare = (p: string): string =>
  readFileSync(resolve(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const SHEETS = {
  "packages/ui/src/composites/list-pane.css": bare("packages/ui/src/composites/list-pane.css"),
  "apps/webapp/app/app.css": bare("apps/webapp/app/app.css"),
} as const;

/** The one size a pile title is allowed to be. */
const TITLE = "20px";

type TitleRule = { sheet: string; selector: string; size: string | null };

/**
 * Every rule that sizes a pile title, at any width.
 *
 * `[^{}]*` cannot cross a brace, so a selector match always begins just after the enclosing `{`
 * or the previous `}` — which is what lets one pass pick up rules nested inside `@media` blocks
 * without parsing the at-rule itself.
 */
const titleRules = (sheet: string, css: string): TitleRule[] => {
  const out: TitleRule[] = [];
  const re = /([^{}]*\bh1\b[^{}]*)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const selector = m[1].trim().replace(/\s+/g, " ");
    if (!/(\.vhead|\.stream-top)\s+h1\b/.test(selector)) continue;
    const size = /font-size:\s*([^;]+)/.exec(m[2]);
    out.push({ sheet, selector, size: size ? size[1].trim() : null });
  }
  return out;
};

const ALL = Object.entries(SHEETS).flatMap(([sheet, css]) => titleRules(sheet, css));
const SIZED = ALL.filter((r) => r.size !== null);

/**
 * THE TOPBAR'S TITLE IS THE OTHER REGISTER (DESIGN-FOLD-WIDTHS §5). Below 1024 the topbar
 * owns the page's name as `h1.tb-title`, and every view's own `.vhead h1` is hidden there — one
 * title on screen. `.tb-title` is NOT a pile title: the scan above deliberately does not match
 * it, and this reads it apart so nobody folds it into the one-size set or lets `.vhead h1` grow
 * a breakpoint size to "match" it.
 */
const topbarTitleRules = (css: string): TitleRule[] => {
  const out: TitleRule[] = [];
  const re = /([^{}]*\.tb-title[^{}]*)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const size = /font-size:\s*([^;]+)/.exec(m[2]);
    out.push({ sheet: "apps/webapp/app/app.css", selector: m[1].trim().replace(/\s+/g, " "), size: size ? size[1].trim() : null });
  }
  return out;
};

describe("below 1024 the topbar's title is the one title, in its own register", () => {
  const app = SHEETS["apps/webapp/app/app.css"];
  it("`.tb-title` declares exactly one size, and it is not the pile title's", () => {
    const sized = topbarTitleRules(app).filter((r) => r.size !== null);
    expect(sized, "no `.tb-title` size — the topbar title lost its register").toHaveLength(1);
    expect(sized[0]!.size).not.toBe(TITLE);
  });
  it("the drawer band hides every view's own heading, so the name is on screen once", () => {
    const at = app.indexOf("@media (max-width: 1023.98px)");
    expect(at, "no drawer band").toBeGreaterThan(-1);
    const band = app.slice(at, app.indexOf("@media (max-width: 699.98px)", at));
    expect(band).toMatch(/\.view \.vhead h1\s*\{\s*display:\s*none;/);
    // …and the hide carries no size: a hidden heading with a breakpoint size would be two sizes.
    const hide = /\.view \.vhead h1\s*\{([^}]*)\}/.exec(band)![1]!;
    expect(hide).not.toMatch(/font-size/);
    // the reading streams' own head carries the pile's name too (REVIEW-026 LOW 3): hidden with it
    expect(band).toMatch(/\.stream-top h1\s*\{\s*display:\s*none;/);
    // the address view: its heading hidden like every other, the person's name drawn once in the meta register
    expect(band).not.toMatch(/\.view-address \.vhead h1\s*\{[^}]*display:\s*block/);
    expect(band).toMatch(/\.view-address \.vhead \.meta-name\s*\{\s*display:\s*block;/);
    expect(app).toMatch(/^\.vhead \.meta-name\s*\{\s*display:\s*none;/m);
  });
  it("Zero draws no topbar at its ribbon tiers, so its own heading stands there (REVIEW-026 LOW 1)", () => {
    const zero = bare("apps/webapp/app/zero-layout.css");
    const at = zero.indexOf("@media (min-width: 392px) and (max-width: 1023.98px)");
    expect(at).toBeGreaterThan(-1);
    const tier = zero.slice(at, zero.indexOf("@media", at + 10));
    expect(tier).toMatch(/\[data-layout="zero"\] \.view \.vhead h1,\s*:root\[data-layout="zero"\] \.stream-top h1\s*\{\s*display:\s*block;/);
  });
});

describe("the pile title is one size at every width", () => {
  /* Anchor: if the selector or the sheet ever moves, this goes red rather than the whole file
     passing vacuously on an empty scan — the shape of failure this repo has been bitten by. */
  it("the base declaration is found, and it is the shared one in packages/ui", () => {
    const base = ALL.find(
      (r) => r.sheet === "packages/ui/src/composites/list-pane.css" && r.selector === ".vhead h1",
    );
    expect(base, "`.vhead h1` no longer exists in list-pane.css").toBeDefined();
    expect(base!.size).toBe(TITLE);
  });

  it("the mobile stream header wears the same size, not one of its own", () => {
    // the SIZED rule: the drawer band's `display: none` for the same selector carries no size
    const stream = SIZED.find((r) => r.selector.includes(".stream-top h1"));
    expect(stream, "`.stream-top h1` no longer exists — Reads/Receipts lost their mobile header?")
      .toBeDefined();
    expect(stream!.size).toBe(TITLE);
  });

  /**
   * THE WHOLE POINT. Desktop and 390px are the same number because there is only one number —
   * the `max-width: 699.98px` block that 390px falls inside is scanned along with everything else.
   */
  it("every rule that sizes a pile title declares the same size", () => {
    expect(SIZED.length, "no pile-title font-size found at all — the scan matched nothing")
      .toBeGreaterThan(0);
    const sizes = [...new Set(SIZED.map((r) => r.size))];
    expect(
      sizes,
      `pile titles are set ${sizes.length} ways: ${SIZED.map((r) => `${r.sheet} ${r.selector} → ${r.size}`).join(", ")}`,
    ).toEqual([TITLE]);
  });
});
