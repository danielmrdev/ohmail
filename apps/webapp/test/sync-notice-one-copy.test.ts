import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * EXACTLY ONE COPY OF THE SYNC SENTENCE IS DISPLAYED, AT EVERY WIDTH.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────────
 *
 * The shell says what a sync is doing in two placements — the strip under the topbar and the
 * rail's own line above the dock — because neither one is on screen at every width: the rail
 * collapses into a closed drawer below 1024px, and a sync line inside a closed drawer is a sync
 * line nobody is told about. `SyncBar.tsx` renders both and `app.css` shows one. That is a
 * deliberate design, and it has a failure mode nothing else can see: if the stylesheet ever
 * shows NEITHER, the product goes silent about a failing mailbox; if it shows BOTH, the same
 * sentence stands on screen twice and two `role="status"` regions announce it in turn.
 *
 * It showed both. The rule was written as two independent queries — a `min-width` hid the
 * strip and a `max-width` one pixel below hid the rail slot — which leaves every width between
 * them matching neither. Fractional viewport widths are ordinary rather than exotic (browser
 * zoom, a device pixel ratio that does not divide evenly, a window dragged to an odd size on a
 * scaled display), so 900.5px (the breakpoint was 900 then; it is 1024 since the width ladder)
 * was reachable and both copies were painted there.
 *
 * ── WHY IT IS ASSERTED AGAINST THE STYLESHEET AND NOT AGAINST A RENDER ──────────────────
 *
 * jsdom applies no author stylesheet and evaluates no media query, so `getComputedStyle` in the
 * suite that mounts the real shell cannot answer "which of these two is the one on screen" — it
 * reports both as present, which is exactly how the hole survived. The stylesheet is the thing
 * that decides, so the stylesheet is the thing under test: the rules are read out of `app.css`
 * and evaluated over a width sweep, including the fractional widths that were the defect.
 *
 * The sweep is the point. A test that checked the source text for one particular spelling would
 * pass for any future rewrite that happened to keep the spelling and fail for any correct one
 * that did not; a sweep states the property — one copy, always — and lets the CSS be written
 * however reads best.
 */

const CSS_PATH = fileURLToPath(new URL("../app/app.css", import.meta.url));

/** A stylesheet region: the top level, or the inside of one `@media` block. */
interface Region {
  /** The media condition, or `null` for the top level. */
  cond: string | null;
  body: string;
}

/**
 * Split a stylesheet into top-level text and `@media` bodies, IN SOURCE ORDER.
 *
 * Order is not a detail — the cascade resolves ties by it, and both of the declarations under
 * test are single-class selectors of equal specificity, so the last matching one is the one that
 * wins. A parser that returned the regions in any other order would answer a different question
 * from the one the browser answers.
 */
function regions(css: string): Region[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Region[] = [];
  let i = 0;
  let plainFrom = 0;
  while (i < clean.length) {
    if (!clean.startsWith("@media", i)) {
      i += 1;
      continue;
    }
    out.push({ cond: null, body: clean.slice(plainFrom, i) });
    const open = clean.indexOf("{", i);
    let depth = 1;
    let j = open + 1;
    while (j < clean.length && depth > 0) {
      if (clean[j] === "{") depth += 1;
      else if (clean[j] === "}") depth -= 1;
      j += 1;
    }
    out.push({ cond: clean.slice(i + "@media".length, open).trim(), body: clean.slice(open + 1, j - 1) });
    i = j;
    plainFrom = j;
  }
  out.push({ cond: null, body: clean.slice(plainFrom) });
  return out;
}

/**
 * The `display` this region declares for exactly this selector, or `null`.
 *
 * "Exactly" is load-bearing: `.sync-bar.busy` and `.sync-bar b` are different rules about
 * different things (the corner pill, the bold half of the sentence) and neither decides whether
 * the strip is on screen. Matching them would make this test answer about the wrong element.
 */
function declaredDisplay(body: string, selector: string): string | null {
  let found: string | null = null;
  for (const chunk of body.split("}")) {
    const brace = chunk.indexOf("{");
    if (brace < 0) continue;
    const selectors = chunk.slice(0, brace).split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    const m = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(chunk.slice(brace + 1));
    if (m) found = m[1]!.trim();
  }
  return found;
}

/** Does this media condition hold at `width` CSS pixels? Width features only. */
function holdsAt(cond: string, width: number): boolean {
  const mins = [...cond.matchAll(/min-width:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
  const maxs = [...cond.matchAll(/max-width:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
  return mins.every((v) => width >= v) && maxs.every((v) => width <= v);
}

/** Whether a width feature is mentioned at all — see the "orthogonal conditions" guard below. */
const isWidthQuery = (cond: string): boolean => /(min|max)-width:/.test(cond);

const CSS = readFileSync(CSS_PATH, "utf8");
const REGIONS = regions(CSS);

/**
 * THE RAIL'S OWN STYLESHEET — read only to assert what it does NOT contain.
 *
 * ── THE DEFECT THAT PUT THIS PARAGRAPH HERE ────────────────────────────────────────────────
 *
 * The host line's resting `display:none` was written in `packages/ui/src/composites/rail.css`,
 * with the rest of the rail's furniture, and its breakpoint in `app.css`. That looks tidy and it
 * does not work: the built bundle concatenates `rail.css` AFTER `app.css`, the two selectors have
 * equal specificity, and a media query adds none — so source order decided and the resting rule
 * won at every width. The line never rendered, anywhere, and nothing failed.
 *
 * The sweep below did not catch it, because it modelled the two sheets in the OTHER order and
 * therefore agreed with the mistake. A render in a real browser is what caught it. So the model
 * is gone rather than corrected: BOTH `display` declarations for both placements now live in
 * `app.css`, next to each other and above the one query that swaps them, and this sweep reads one
 * file exactly as the sync pair's does. The invariant that makes the single-file model true is
 * then asserted directly — `rail.css` declares no `display` for `.rail-host` at all — so the day
 * somebody puts one back, this file says so instead of quietly measuring the wrong cascade.
 */
const RAIL_CSS = readFileSync(
  fileURLToPath(new URL("../../../packages/ui/src/composites/rail.css", import.meta.url)),
  "utf8",
);

/** The winning `display` for a selector at a width, or `fallback` if nothing declares one. */
function displayAt(selector: string, width: number, fallback: string): string {
  let winner = fallback;
  for (const region of REGIONS) {
    if (region.cond !== null && !holdsAt(region.cond, width)) continue;
    const declared = declaredDisplay(region.body, selector);
    if (declared !== null) winner = declared;
  }
  return winner;
}

const shown = (selector: string, width: number, fallback: string): boolean =>
  displayAt(selector, width, fallback) !== "none";

/**
 * The two placements. The fallbacks are each element's initial `display` — both are `div`s, so
 * absent any rule they are `block`, which is to say VISIBLE. That polarity matters: a fallback of
 * "none" would let a stylesheet that declares nothing at all pass this file.
 */
const STRIP = ".sync-bar";
const RAIL_SLOT = ".rail-sync-slot";

/**
 * The widths to check. Every integer across the range a browser window can be, plus the
 * fractional quarters around the breakpoint — those are the ones the two-query spelling got
 * wrong, and an integer-only sweep is exactly how it went unnoticed.
 */
function widths(): number[] {
  const out: number[] = [];
  for (let w = 240; w <= 2560; w += 1) out.push(w);
  for (const w of [1023.5, 1023.98, 1023.99, 1024.01, 1024.25, 1024.5, 1024.75, 1024.99, 1025.5]) out.push(w);
  return out;
}

describe("the sync sentence is on screen exactly once", () => {
  it("the parser found the rules it is about — otherwise every sweep below is vacuous", () => {
    // A selector rename, a file move, or a parser that silently matched nothing would make this
    // file report a perfect stylesheet about rules it never read.
    expect(CSS, "app.css does not carry the strip").toContain(".sync-bar");
    expect(CSS, "app.css does not carry the rail slot").toContain(".rail-sync-slot");
    const declaring = REGIONS.filter(
      (r) => declaredDisplay(r.body, STRIP) !== null || declaredDisplay(r.body, RAIL_SLOT) !== null,
    );
    expect(declaring.length, "no region declares `display` for either placement").toBeGreaterThan(1);
    // At least one of them must be inside a width query, or the sweep is testing a constant.
    expect(
      declaring.some((r) => r.cond !== null && isWidthQuery(r.cond)),
      "neither placement's visibility depends on the width — one of them is on screen always",
    ).toBe(true);
  });

  it("exactly one placement is displayed at every width, fractions included", () => {
    const both: number[] = [];
    const neither: number[] = [];
    for (const w of widths()) {
      const strip = shown(STRIP, w, "block");
      const rail = shown(RAIL_SLOT, w, "block");
      if (strip && rail) both.push(w);
      if (!strip && !rail) neither.push(w);
    }
    expect(
      neither,
      "at these widths NEITHER copy is displayed — a failing mailbox says nothing anywhere",
    ).toEqual([]);
    expect(
      both,
      "at these widths BOTH copies are displayed — the same sentence twice on screen, and two " +
        "`role=\"status\"` regions announcing it in turn",
    ).toEqual([]);
  });

  it("the rail's line is the one shown at desktop widths, and the strip below the rail's own", () => {
    // The direction, not merely the count: a stylesheet that showed exactly one copy but the
    // WRONG one at each width would satisfy the sweep above and put the sentence inside a
    // closed drawer on a phone.
    expect(shown(RAIL_SLOT, 1440, "block"), "the rail carries no sync line at 1440").toBe(true);
    expect(shown(STRIP, 1440, "block"), "the strip is painted at 1440 as well as the rail").toBe(false);
    expect(shown(STRIP, 390, "block"), "the phone has no sync strip").toBe(true);
    expect(shown(RAIL_SLOT, 390, "block"), "the sentence is in the closed drawer on a phone").toBe(false);
  });

  it("nothing outside a width query decides which copy is on screen", () => {
    // A `prefers-reduced-motion` or `hover` block that hid one of these would make the property
    // above depend on something this sweep does not model — a true result about the wrong world.
    const orthogonal = REGIONS.filter(
      (r) =>
        r.cond !== null &&
        !isWidthQuery(r.cond) &&
        (declaredDisplay(r.body, STRIP) !== null || declaredDisplay(r.body, RAIL_SLOT) !== null),
    ).map((r) => r.cond);
    expect(orthogonal, "a non-width media query decides one placement's visibility").toEqual([]);
  });
});

/**
 * ═══ AND THE SAME PROPERTY FOR THE PAIRED DESKTOP'S STANDING LINE ═════════════════════════
 *
 * "The computer that organizes your mail is not answering" is rendered in the same two
 * placements, for the same reason and — critically — from the SAME single `min-width: 1024px`
 * query. It has to hold to the same property, and the stakes are a notch higher: the sync
 * sentence describes a process that will resolve itself either way, and this one describes a
 * window in which nothing the person presses will work. Shown twice it is noise; shown nowhere,
 * somebody presses Delete for ten minutes and is refused each time with no explanation standing
 * anywhere on screen.
 *
 * THE FALLBACKS DIFFER FROM THE PAIR ABOVE, and they are the honest ones for these elements: both
 * carry an explicit `display` at rest (`flex` for the strip, `none` for the rail line), so the
 * fallback here is only reached if every rule for a selector disappears — which the vacuity guard
 * below is what catches.
 */
const HOST_STRIP = ".host-strip";
const HOST_RAIL = ".rail-host";

describe("the paired desktop's standing line is on screen exactly once", () => {
  it("the parser found both rules — otherwise the sweep below is vacuous", () => {
    expect(RAIL_CSS, "rail.css does not carry the rail form's styling").toContain(".rail-host");
    expect(CSS, "app.css does not carry the shell form").toContain(".host-strip");
    /* THE INVARIANT THE SINGLE-FILE MODEL RESTS ON. `rail.css` is concatenated AFTER `app.css`,
       so a `display` for `.rail-host` there would beat the query below at every width and the
       line would never render — which is exactly what happened, and what the two-file model this
       file used to carry could not see. */
    for (const region of regions(RAIL_CSS)) {
      expect(
        declaredDisplay(region.body, HOST_RAIL),
        "rail.css declares `display` for `.rail-host`; it loads after app.css and would win at "
          + "every width. Both display rules belong in app.css, beside the breakpoint.",
      ).toBeNull();
    }
    const declaring = REGIONS.filter(
      (r) =>
        declaredDisplay(r.body, HOST_STRIP) !== null || declaredDisplay(r.body, HOST_RAIL) !== null,
    );
    expect(declaring.length, "no region declares `display` for either placement").toBeGreaterThan(1);
    expect(
      declaring.some((r) => r.cond !== null && isWidthQuery(r.cond)),
      "neither placement's visibility depends on the width — one of them is on screen always",
    ).toBe(true);
  });

  it("exactly one placement is displayed at every width, fractions included", () => {
    const both: number[] = [];
    const neither: number[] = [];
    for (const w of widths()) {
      const strip = shown(HOST_STRIP, w, "block");
      const rail = shown(HOST_RAIL, w, "block");
      if (strip && rail) both.push(w);
      if (!strip && !rail) neither.push(w);
    }
    expect(
      neither,
      "at these widths NEITHER copy is displayed — a window that can change nothing says so nowhere",
    ).toEqual([]);
    expect(both, "at these widths BOTH copies are displayed").toEqual([]);
  });

  it("the rail carries it at desktop widths and the strip below the rail's own", () => {
    expect(shown(HOST_RAIL, 1440, "block"), "the rail carries no host line at 1440").toBe(true);
    expect(shown(HOST_STRIP, 1440, "block"), "the strip is painted at 1440 too").toBe(false);
    expect(shown(HOST_STRIP, 640, "block"), "no host strip at 640").toBe(true);
    expect(shown(HOST_RAIL, 640, "block"), "the sentence is in the closed drawer at 640").toBe(false);
    expect(shown(HOST_STRIP, 1023, "block"), "no host strip at exactly 1023").toBe(true);
    expect(shown(HOST_STRIP, 1023.99, "block"), "no host strip at 1023.99 — the fraction under the edge").toBe(true);
    expect(shown(HOST_RAIL, 1024, "block"), "the rail form is not on at exactly 1024").toBe(true);
  });

  it("BOTH PAIRS SWAP AT THE SAME NUMBER — one rule, not two that happen to agree today", () => {
    /* The sync pair and the host pair are swapped by the same query in the same file, and that is
       a property worth stating rather than a coincidence to rely on: two breakpoints that differ
       by a pixel would put the sync sentence in the rail and the host sentence in the strip at
       one width, which is a layout nobody designed and nobody would think to look at. */
    for (const w of [1023, 1023.98, 1024, 1025, 1023.99]) {
      expect(
        shown(HOST_RAIL, w, "block"),
        `the host line and the sync line disagree about the rail at ${w}px`,
      ).toBe(shown(RAIL_SLOT, w, "block"));
    }
  });
});

/**
 * ═══ AND THE ORGANIZER NOTICE'S PAIR (DESIGN-026 §1.3) ═══════════════════════════════════════
 *
 * Who organizes a mailbox changed: the rail's foot at width, the topbar twin under 1024px, swapped
 * by the SAME single query — never both copies, never neither while there is something to say.
 */
const NOTICE_SHELL = ".notice-shell";
const NOTICE_RAIL = ".rail-notice-slot";

describe("the organizer notice is on screen exactly once", () => {
  it("the parser found both rules, and rail.css declares no display for the slot", () => {
    expect(RAIL_CSS).toContain(".rail-notice-slot");
    expect(CSS).toContain(".notice-shell");
    for (const region of regions(RAIL_CSS)) {
      expect(declaredDisplay(region.body, NOTICE_RAIL),
        "rail.css declares `display` for the notice slot; it loads after app.css and would win").toBeNull();
    }
    const declaring = REGIONS.filter((r) =>
      declaredDisplay(r.body, NOTICE_SHELL) !== null || declaredDisplay(r.body, NOTICE_RAIL) !== null);
    expect(declaring.some((r) => r.cond !== null && isWidthQuery(r.cond))).toBe(true);
  });

  it("exactly one placement is displayed at every width, fractions included", () => {
    const both: number[] = [];
    const neither: number[] = [];
    for (const w of widths()) {
      const shell = shown(NOTICE_SHELL, w, "block");
      const rail = shown(NOTICE_RAIL, w, "block");
      if (shell && rail) both.push(w);
      if (!shell && !rail) neither.push(w);
    }
    expect(neither, "at these widths NEITHER copy is displayed").toEqual([]);
    expect(both, "at these widths BOTH copies are displayed").toEqual([]);
  });

  it("the rail carries it at width and the twin below, at the sync pair's number", () => {
    expect(shown(NOTICE_RAIL, 1440, "block")).toBe(true);
    expect(shown(NOTICE_SHELL, 1440, "block")).toBe(false);
    expect(shown(NOTICE_SHELL, 390, "block")).toBe(true);
    expect(shown(NOTICE_RAIL, 390, "block")).toBe(false);
    for (const w of [1023, 1023.98, 1023.99, 1024, 1025]) {
      expect(shown(NOTICE_RAIL, w, "block"), `the notice and the sync line disagree at ${w}px`)
        .toBe(shown(RAIL_SLOT, w, "block"));
    }
  });
});
