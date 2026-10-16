import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Icon, MessageRow } from "@ohmail/ui";

/**
 * ═══ A ROW'S HOVER ACTION NEVER LANDS ON ITS TEXT — MEASURED IN A REAL ENGINE ════════════════
 *
 * Reported from use: hovering a resurfaced row drew the "Done" control ON the truncated
 * subject's tail and on the row's trailing glyphs, so a deliberate control read as a rendering
 * fault. The action slot floated over the row (absolute, zero layout width) for one release,
 * which is exactly what put it there. It is now the row's own trailing COLUMN (`row.css`).
 *
 * jsdom lays nothing out, so the property is unmeasurable there — this drives headless Chromium
 * over the real `MessageRow` and the real stylesheets and reads `getBoundingClientRect`. For
 * every list width, every reveal state and both surfaces that draw an action, no action box may
 * intersect the subject, the stamp or any badge-strip glyph; hovering may not move the subject;
 * and the subject must be the thing that truncates.
 *
 * THE RED CONTROL IS THE PRE-FIX LAYOUT, re-applied as an override on the same page
 * ({@link PRE_FIX}): the floating slot returns and the same measurement reads intersections.
 * An arm that only admits proves nothing, so the last describe fails if it finds none.
 */

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

/** The cascade a product row actually renders under, in the order the app loads it. */
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/ui/src/base.css",
  "packages/ui/src/composites/row.css",
  "apps/webapp/app/app.css",
].map(css).join("\n");

/**
 * The layout this fix replaced, stated as an override rather than read out of git: the slot out
 * of flow at the row's trailing end, the row keeping the full width, the fade's ramp padding.
 */
const PRE_FIX = `
.row-slot{display:block}
.row-actions{position:absolute;top:0;bottom:0;right:0;z-index:2}
.row-actions-in{padding:0 12px 0 28px}
`;

/** `LIST.min` / `LIST.dflt` / `LIST.max` from `app/shell/column-store.ts` — the list's own track. */
const WIDTHS = [320, 400, 720] as const;

/** Fixture rows only — a resurfaced Ohbox row and a waiting Screener row, both invented here. */
const SUBJECT =
  "Quarterly hosting invoice and the renewal terms for the coming period, with the usage summary";

const ohboxAction = (
  <button type="button" className="rsf-done" aria-label="Done" title="Done">
    <Icon name="check" size={12} />
    Done
  </button>
);

const screenerAction = (
  <>
    <button type="button" className="scn-act scn-act-yes" aria-label="Accept" title="Accept">
      Accept
    </button>
    <button type="button" className="scn-act scn-act-more" aria-label="More" title="More">
      <Icon name="chev" className="chev" />
    </button>
  </>
);

const SURFACES = [
  { name: "the Ohbox's resurfaced row (Done)", actions: ohboxAction },
  { name: "the Screener's waiting row (Accept + menu)", actions: screenerAction },
] as const;

/** The heaviest row the list language can draw, at the narrowest width it supports. */
const heavy = {
  destination: "Reads",
  amount: "1 240.00",
  protectedLabel: "protected",
  mailbox: "work@fixture.invalid",
  participants: [
    { initials: "A", hue: 4 },
    { initials: "B", hue: 40 },
    { initials: "C", hue: 90 },
  ],
  tags: [{ name: "hosting", hue: "moss" as const }, { name: "renewals", hue: "sky" as const }],
} as const;

const markup = (actions: ReactNode, extraProps: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(
    <MessageRow
      id="fixture-1"
      from="Fixture Billing"
      avatarInitial="F"
      avatarHue={12}
      time="09:14"
      subject={SUBJECT}
      preview="The attached summary covers the period and the renewal terms in full"
      newSinceLabel="2 new"
      threadCount={3}
      hasAttachment
      unread
      actions={actions}
      {...extraProps}
    />,
  );

const page_ = (body: string, width: number, extra: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${SHEETS}${extra}</style>
   <style>body{margin:0;font-family:system-ui,sans-serif}</style></head>
   <body class="mo-canvas"><div class="rows" style="width:${width}px">${body}</div></body></html>`;

type Box = { name: string; left: number; right: number; top: number; bottom: number };
type Reading = { content: Box[]; actions: Box[]; subject: Box; truncated: boolean; overflow: number;
  wrapperWidth: number | null; surface: { box: Box; paint: string; rowPaint: string } | null };

const overlap = (a: Box, b: Box): boolean =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => {
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

/**
 * One reading: the row painted at `width`, put into `state`, every drawn text/glyph box inside
 * the row button and every control box in the slot measured off the live layout.
 */
async function read(
  actions: ReactNode,
  width: number,
  state: "rest" | "hover" | "focus",
  extra = "",
  extraProps: Record<string, unknown> = {},
): Promise<Reading> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.setContent(page_(markup(actions, extraProps), width, extra));
    if (state === "hover") await page.hover(".row");
    if (state === "focus") await page.focus(".row");
    return await page.evaluate(() => {
      /* THE BOX A READER SEES, not the box the layout gives. The badge strip is `overflow:hidden`
         and the give-way order clips its tail members, whose layout rects keep running past the
         clip — measuring those would report a collision with a glyph that is not drawn. So each
         box is intersected with every clipping ancestor up to the row, and an element clipped to
         nothing is not measured at all. */
      const box = (el: Element, name: string) => {
        const r = el.getBoundingClientRect();
        let left = r.left, right = r.right, top = r.top, bottom = r.bottom;
        for (let p = el.parentElement; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (s.overflowX !== "visible" || s.overflowY !== "visible") {
            const c = p.getBoundingClientRect();
            left = Math.max(left, c.left); right = Math.min(right, c.right);
            top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom);
          }
          if (p.classList.contains("row-slot")) break;
        }
        return { name, left, right, top, bottom };
      };
      const drawn = (b: { left: number; right: number; top: number; bottom: number }): boolean =>
        b.right - b.left > 0.5 && b.bottom - b.top > 0.5;
      const row = document.querySelector(".row")!;
      const subj = row.querySelector(".subj")!;
      const content = [
        box(subj, ".subj"),
        ...Array.from(row.querySelectorAll(".row-top .t")).map((e) => box(e, ".row-top .t")),
        ...Array.from(row.querySelectorAll(".badges > *")).map((e, i) => box(e, `.badges[${i}]`)),
        ...Array.from(row.querySelectorAll(".prev")).map((e) => box(e, ".prev")),
      ].filter(drawn);
      const actionEls = Array.from(
        document.querySelectorAll(".row-actions .rsf-done, .row-actions .scn-act"),
      );
      const slot = document.querySelector(".row-slot") as HTMLElement | null;
      const wrap = document.querySelector(".row-actions") as HTMLElement | null;
      return {
        wrapperWidth: wrap ? wrap.getBoundingClientRect().width : null,
        surface: slot
          ? { box: box(slot, ".row-slot"), paint: getComputedStyle(slot).backgroundColor,
              rowPaint: getComputedStyle(row).backgroundColor }
          : null,
        content,
        actions: actionEls.map((e, i) => box(e, `action[${i}]`)),
        subject: box(subj, ".subj"),
        truncated: subj.scrollWidth > subj.clientWidth,
        overflow: Math.round(row.scrollWidth - row.clientWidth),
      };
    });
  } finally {
    await page.close();
  }
}

const collisions = (r: Reading): string[] =>
  r.actions.flatMap((a) => r.content.filter((c) => overlap(a, c)).map((c) => `${a.name} × ${c.name}`));

describe("every row action stands in its own slot, over nothing", () => {
  for (const surface of SURFACES)
    for (const width of WIDTHS)
      for (const state of ["rest", "hover", "focus"] as const)
        it(
          `${surface.name} at ${width}px, ${state}: no action box touches text or a glyph`,
          async () => {
            const r = await read(surface.actions, width, state);
            expect(r.actions.length, "no action rendered — the reading measures nothing").toBeGreaterThan(0);
            expect(r.content.length, "no row content rendered").toBeGreaterThan(2);
            expect(collisions(r), "an action is drawn over the row's own text or glyphs").toEqual([]);
          },
          60_000,
        );

  it("the subject is what truncates, and it truncates before the slot", async () => {
    for (const width of [320, 400] as const) {
      const r = await read(ohboxAction, width, "hover");
      expect(r.truncated, `the fixture subject is not clipped at ${width}px — nothing is under test`)
        .toBe(true);
      const action = r.actions[0]!;
      expect(r.subject.right, `the subject reaches into the slot at ${width}px`)
        .toBeLessThanOrEqual(action.left + 0.5);
    }
  }, 60_000);

  it("revealing the action moves nothing — the subject's box is the same at rest", async () => {
    for (const surface of SURFACES) {
      const rest = await read(surface.actions, 400, "rest");
      const hover = await read(surface.actions, 400, "hover");
      expect(hover.subject.left, `${surface.name}: hover moved the subject`).toBeCloseTo(rest.subject.left, 1);
      expect(hover.subject.right, `${surface.name}: hover resized the subject`).toBeCloseTo(rest.subject.right, 1);
    }
  }, 60_000);

  it("the heaviest row the language draws still clips inside its own track", async () => {
    // Every bounded mark at once plus an amount and a destination, at `LIST.min`: the row button
    // is a grid ITEM, whose automatic minimum is its min-content width, so without `min-width:0`
    // a row like this pushes the slot off its own right edge and the controls land on the badges.
    const r = await read(screenerAction, 320, "hover", "", heavy);
    expect(r.overflow, "the row's content is wider than its track — the slot has been pushed off")
      .toBeLessThanOrEqual(0);
    expect(collisions(r), "an action is drawn over the heaviest row's text or glyphs").toEqual([]);
  }, 60_000);

  it("the row's surface reaches under the slot — the control stands ON the row", async () => {
    // The row button is only the first track, so its own hover paint would stop short of the
    // control and leave it standing in the list's gutter. The slot carries the surface instead.
    const hover = await read(ohboxAction, 400, "hover");
    const s = hover.surface!;
    expect(s, "no slot rendered").not.toBeNull();
    expect(s.paint, "the slot is unpainted on hover — the control stands beside the row")
      .not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(s.rowPaint, "the row button paints its own surface inside the slot — the tint doubles")
      .toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    const a = hover.actions[0]!;
    expect(a.left, "the control sits outside the row's surface").toBeGreaterThanOrEqual(s.box.left);
    expect(a.right, "the control sits outside the row's surface").toBeLessThanOrEqual(s.box.right);
  }, 60_000);

  it("an empty slot costs the row no width, and leaves no stub under a departing row", async () => {
    // Both surfaces empty the slot rather than dropping the prop, for the exit and for a row that
    // has nothing to offer; `.row-actions-in:empty` is what makes that free. `.row.out` takes the
    // button's height to zero, and the slot is the other track of the same row.
    const live = await read(null, 400, "rest");
    const held = await read(ohboxAction, 400, "rest");
    expect(held.wrapperWidth, "the slot reserves nothing for the control it holds")
      .toBeGreaterThan(20);
    expect(live.wrapperWidth, "an empty slot still reserves width — every actionless row pays it")
      .toBeLessThanOrEqual(0.5);
    const out = await read(null, 400, "rest", "", { className: "out" });
    expect(live.surface!.box.bottom - live.surface!.box.top, "the fixture row has no height")
      .toBeGreaterThan(10);
    expect(out.surface!.box.bottom - out.surface!.box.top, "the departing row's slot holds a stub")
      .toBeLessThanOrEqual(1);
  }, 60_000);

  it("a row with no action keeps the whole width — the slot costs an actionless row nothing", async () => {
    const withAction = await read(ohboxAction, 400, "rest");
    const without = await read(null, 400, "rest");
    expect(without.subject.right, "an empty slot still reserves a column")
      .toBeGreaterThan(withAction.subject.right);
  }, 60_000);
});

describe("the pre-fix layout is the red control", () => {
  it("restoring the floating slot puts the action back over the row's own text", async () => {
    const found: string[] = [];
    for (const surface of SURFACES)
      for (const width of WIDTHS) {
        const r = await read(surface.actions, width, "hover", PRE_FIX);
        found.push(...collisions(r).map((c) => `${surface.name} @${width}: ${c}`));
      }
    expect(
      found.length,
      "the pre-fix layout read NO intersection — the measurement cannot see the defect it guards",
    ).toBeGreaterThan(0);
  }, 120_000);
});
