/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * THE FROM SELECTOR IS A CONTROL, AND IT MUST NOT BE PAINTED AS A FIELD THAT IS BEING HELD.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────
 *
 * `app.css` recessed a held header field by one ink step with a bare `.c-input:read-only`. Both
 * compose header inputs are `readOnly` mid-send, so on an `<input>` that rule says exactly what it
 * means. On the From `<select>` — which carries the same `.c-input` class — it never stopped
 * saying it: **a `<select>` matches `:read-only` ALWAYS.** The pseudo-class does not mean "held",
 * it means "not an editable text control", and by the spec only an editable `<input>`/`<textarea>`
 * ever matches `:read-write`. So the one control on the compose header rendered permanently at
 * `--ink2`, one step under the address text everywhere else on the form — while the ONE-mailbox
 * case, an `<output class="c-static">` with no `:read-only` rule over it, rendered at full `--ink`.
 * The account with a choice got the disabled-looking line; the account with no choice got the live
 * one. Nothing was broken in the markup or the shell: the control worked, opened and submitted.
 *
 * The mirror of this already stands further down the same file. `.reply-editor.is-locked` exists
 * because a `contenteditable` has NO `:read-only` to hook — the other end of the same mistake,
 * corrected the same way: name the state, do not borrow a pseudo-class that means something else.
 *
 * ── WHY THIS TEST INJECTS THE REAL STYLESHEET ───────────────────────────────────────────────
 *
 * Because CSS is invisible to `tsc` and to every other test here, and because the defect is a
 * CASCADE result, not a string: `.c-input:read-only` (0,2,0) outranking `.c-input` (0,1,0) on an
 * element nobody expected to match it. A source-text assertion alone would go green against a
 * stylesheet that reintroduced the same recession through some other selector. So the real
 * `app.css` is parsed into a real document and the assertions read `getComputedStyle` — jsdom
 * resolves selectors with `nwsapi` and applies the actual cascade, and it reproduces the shipped
 * bug faithfully (measured: the select computed `var(--ink2)` before the fix, `var(--ink)` after).
 *
 * TWO HONEST LIMITS, both stated rather than papered over:
 *
 *  1. jsdom does not resolve `var()`. `getComputedStyle().color` therefore answers the literal
 *     `"var(--ink)"` / `"var(--ink2)"`, which is the cascade's winner named by its token — enough
 *     to tell "the value ink" from "the held ink", which is the whole of this defect.
 *  2. jsdom throws `Not implemented` for `getComputedStyle(el, "::after")`, so the caret's own
 *     colour and its hover state cannot be computed here and are asserted at the stylesheet
 *     source in the third block. They WERE measured in a real browser by hand (Chromium, the real
 *     `app.css` + `tokens.css`, 660px compose panel): caret at rest `oklch(0.42 0.015 60)` =
 *     `--ink2`, hover `oklch(0.245 0.012 60)` = `--ink`, mid-send `oklch(0.47 0.016 62)` =
 *     `--ink3`; and the caret moved from x≈678 (466px past the end of the address, at the panel's
 *     far edge) to x≈221, 8px after it.
 *
 * MUTATION WATCH (2026-08-11) — four mutations run against this file, each watched go red and
 * then restored:
 *   · restore the bare `.c-input:read-only { color: var(--ink2) }` → 2 failures, and the first is
 *     the COMPUTED one: the select answers `var(--ink2)` where the case wants `var(--ink)`;
 *   · drop the `textarea` half of the restricted rule → 2 failures, so the fix cannot be "made to
 *     pass" by narrowing the recession until it applies to nothing;
 *   · put `flex: 1` back on `.c-select select` → the caret-adjacency case fails (`flexGrow` 1);
 *   · put the caret back to `--ink3` → the caret-colour case fails.
 */

const CSS_PATH = "apps/webapp/app/app.css";
const appCss = readFileSync(resolve(process.cwd(), CSS_PATH), "utf8");
/** The same comment-stripped read the other stylesheet guards here use. */
const bare = appCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** Body of the first top-level rule whose selector list starts with `sel` (no nested braces). */
const ruleBody = (css: string, sel: string): string | null => {
  const re = new RegExp(`(?:^|[};])\\s*${sel}\\s*\\{([^{}]*)\\}`, "m");
  const m = re.exec(css);
  return m ? m[1] : null;
};

/**
 * The compose header, in the shape `ComposeView` renders it — the two-mailbox branch (a
 * `<select class="c-input">` inside `.c-select`), the one-mailbox branch (`<output class="c-static">`),
 * and the sibling fields whose held state must survive this fix untouched.
 */
const MARKUP = `
<div class="compose-wrap"><div class="compose-head">
  <div class="c-field">
    <label for="compose-from">From</label>
    <span class="c-select">
      <select id="compose-from" class="c-input">
        <option value="milabrunner">hello@milabrunner.example</option>
        <option value="lichtgrat">mila@lichtgrat.example</option>
      </select>
    </span>
  </div>
  <div class="c-field">
    <span class="c-select">
      <select id="from-mid-send" class="c-input" disabled>
        <option value="milabrunner">hello@milabrunner.example</option>
      </select>
    </span>
  </div>
  <div class="c-field"><output id="from-only" class="c-static">hello@milabrunner.example</output></div>
  <div class="c-field"><input id="to" class="c-input" /></div>
  <div class="c-field"><input id="to-mid-send" class="c-input" readonly /></div>
  <div class="c-field"><textarea id="subject-mid-send" class="c-input" readonly></textarea></div>
</div></div>`;

const el = (id: string): HTMLElement => document.getElementById(id)!;
const colorOf = (id: string): string => window.getComputedStyle(el(id)).color;

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.appendChild(style);
  document.body.innerHTML = MARKUP;
  // If jsdom ever fails to parse the sheet it drops it silently and EVERY colour below answers
  // `""` — which would read as "no recession", i.e. this whole file passing while asserting
  // nothing. Fail loudly instead.
  expect(
    colorOf("to"),
    `app.css did not reach the document — every computed colour here would be empty`,
  ).not.toBe("");
});

describe("a <select> is not a held field, whatever `:read-only` says about it", () => {
  it("the From selector renders at the VALUE ink, like the address it is showing", () => {
    expect(
      colorOf("compose-from"),
      "the From selector is painted as a held/disabled field again (`.c-input:read-only` is back)",
    ).toBe("var(--ink)");
  });

  it("…and it matches `:read-only` while doing so — which is exactly why the rule had to name elements", () => {
    // Not decoration: this is the fact the defect rested on. If a future jsdom/nwsapi stopped
    // matching here, the case above would pass for a reason that does not hold in a browser, and
    // this assertion is what would go red instead of that silently happening.
    expect(
      el("compose-from").matches(":read-only"),
      "a <select> stopped matching `:read-only` — the case above no longer proves anything",
    ).toBe(true);
    expect(el("compose-from").matches(":read-write")).toBe(false);
  });

  it("the one-mailbox line is untouched — it always rendered correctly and still does", () => {
    expect(colorOf("from-only")).toBe("var(--ink)");
  });

  it("mid-send the selector DOES recede — through `:disabled`, the state it is actually in", () => {
    expect(
      colorOf("from-mid-send"),
      "the selector no longer recedes while the send is in flight",
    ).toBe("var(--ink2)");
  });
});

describe("the held recession still applies to the fields that can actually be held", () => {
  it("an editable header input is at the value ink", () => {
    expect(colorOf("to")).toBe("var(--ink)");
  });

  it("a readOnly <input> recedes one ink step", () => {
    expect(
      colorOf("to-mid-send"),
      "the mid-send recession was deleted instead of being restricted to the elements it means",
    ).toBe("var(--ink2)");
  });

  it("a readOnly <textarea> recedes one ink step", () => {
    expect(colorOf("subject-mid-send")).toBe("var(--ink2)");
  });
});

describe("the caret sits with the address, not at the far edge of the row", () => {
  it("the selector does not stretch to fill the row (that is what pushed the caret away)", () => {
    // The wrapper draws the caret as its own `::after`, so a select that grows takes the whole
    // row and the caret lands against the panel's edge — measured at 466px from the end of the
    // address, at the compose panel's own width.
    expect(
      window.getComputedStyle(el("compose-from")).flexGrow,
      "`.c-select select` is growing again — the caret is back at the far edge of the row",
    ).toBe("0");
  });

  it("the wrapper hugs the control too, so the hover target is the control and not the row", () => {
    expect(window.getComputedStyle(el("compose-from").parentElement!).flexGrow).toBe("0");
  });

  /* ── the caret's own paint: source-level, because jsdom has no pseudo-element computed style ── */

  it("the caret is one ink step under the address, not two", () => {
    const body = ruleBody(bare, "\\.c-select::after");
    expect(body, "no `.c-select::after` caret rule in app.css").not.toBeNull();
    expect(
      body!,
      "the caret is back at `--ink3` — quieter than the label beside it, on the block's only control",
    ).toMatch(/border-top:[^;]*var\(--ink2\)/);
  });

  it("hover takes it to the full ink — the same two-state idiom as the Cc/Bcc control below it", () => {
    const hover = ruleBody(bare, "\\.c-select:hover::after");
    expect(hover, "the From control lost its hover affordance").not.toBeNull();
    expect(hover!).toMatch(/border-top-color:\s*var\(--ink\)/);
  });

  it("mid-send the caret recedes with the text it belongs to", () => {
    const held = ruleBody(bare, "\\.c-select:has\\(select:disabled\\)::after");
    expect(held, "the caret still advertises a menu that will not open mid-send").not.toBeNull();
    expect(held!).toMatch(/border-top-color:\s*var\(--ink3\)/);
  });
});

describe("the rule that caused this cannot come back unnoticed", () => {
  it("no bare `.c-input:read-only` — the held recession is named by element", () => {
    // The computed-style cases above are the real guard; this one names the exact regression, so
    // a reader of a failing run is told WHICH selector to look for rather than a colour.
    expect(
      /(?:^|[};])\s*\.c-input:read-only\s*\{/.test(bare),
      "`.c-input:read-only` is back — it paints every <select> carrying `.c-input` as held",
    ).toBe(false);
    expect(bare, "the held recession no longer names the elements it applies to").toMatch(
      /input\.c-input:read-only[\s\S]{0,60}textarea\.c-input:read-only/,
    );
  });
});
