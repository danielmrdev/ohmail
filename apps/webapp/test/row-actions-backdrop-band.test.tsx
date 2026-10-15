/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MessageRow } from "@ohmail/ui";

/**
 * THE ROW CONTROLS COVER NOTHING — SO THERE IS NOTHING TO MASK.
 *
 * The file keeps the name of the band it used to guard; the band is what went.
 *
 * They used to float over the row's trailing end, and the fade behind them was painted on a box
 * as tall as the ROW: on a phone, where the controls stand at rest, that overlay sat on the
 * stamp's line and every Screener row's time read one or two digits (the project's design notes
 * `MT-F1-SCREENER-STAMP-MASKED`). Shrinking the backdrop to
 * the controls' own box answered the stamp and left the subject's line covered, which is what the
 * Ohbox's "Done" was then reported drawing on (owner, 2026-09-22).
 *
 * The controls now stand in the row's own trailing COLUMN (`row.css`), so no part of the row is
 * behind them in any state, on any device, whatever the buttons say — and a backdrop would paint a
 * band of the row's colour BESIDE the row rather than under anything. So the rule is that there is
 * no backdrop at all, and that the slot keeps no box that could reach back over the row. The
 * geometry is measured in a real engine by `row-action-slot-geometry.test.tsx`; jsdom lays nothing
 * out, so what is decidable here is the stylesheet and the element tree.
 *
 * MUTATION WATCH (2026-09-22): a gradient rule on either box turns the first case red; giving
 * `.row-actions-in` a `position`/`top`/`bottom`/`height`/`inset` turns the second red; dropping
 * the touch arm turns the third; nesting a control inside the row button turns the last red.
 */

const bare = (p: string): string =>
  readFileSync(resolve(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const rowCss = bare("packages/ui/src/composites/row.css");

/** Every declaration block in a stylesheet, with the `@media` condition it sits under (or ""). */
type Block = { media: string; selector: string; body: string };
function blocks(css: string): Block[] {
  // A hand walk rather than one regex: a regex that reads `selector{body}` cannot tell a rule
  // INSIDE an `@media` from the one after it, and mis-attributing the condition is exactly the
  // mistake this file exists to catch.
  const out: Block[] = [];
  let i = 0;
  let start = 0;
  let media = "";
  let depth = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === "{") {
      const head = css.slice(start, i).trim();
      if (depth === 0 && head.startsWith("@")) {
        media = /^@media([^{]*)$/.exec(head)?.[1].trim() ?? head;
        depth = 1;
        i += 1;
        start = i;
        continue;
      }
      const end = css.indexOf("}", i);
      out.push({ media, selector: head, body: css.slice(i + 1, end === -1 ? css.length : end) });
      i = (end === -1 ? css.length : end) + 1;
      start = i;
      continue;
    }
    if (c === "}") {
      depth = 0;
      media = "";
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  return out;
}

/** The last compound selector of each comma-separated selector — what the rule actually styles. */
const subjects = (selector: string): string[] =>
  selector
    .split(",")
    .map((s) => s.trim().split(/[\s>+~]+/).filter(Boolean).pop() ?? "")
    .filter(Boolean);

const isWrapper = (s: string): boolean => /^\.row-actions(?![\w-])/.test(s);
const isBand = (s: string): boolean => /^\.row-actions-in(?![\w-])/.test(s);

const all = blocks(rowCss);

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
  document.head.querySelector("#row-css")?.remove();
});

/** The real component, the real stylesheet, one row with controls in its slot. */
function paint(opts: { selected?: boolean; label?: string } = {}): {
  wrapper: HTMLElement;
  band: HTMLElement;
  row: HTMLElement;
} {
  const style = document.createElement("style");
  style.id = "row-css";
  style.textContent = rowCss;
  document.head.append(style);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const actions = React.createElement(
    "button",
    { type: "button", className: "scn-act scn-act-yes" },
    opts.label ?? "Accept",
  );
  // React 19 renders synchronously enough for a layout-free read; `act` is not needed because
  // nothing here schedules an effect.
  (React as unknown as { act: (cb: () => void) => void }).act(() => {
    root!.render(
      React.createElement(MessageRow, {
        id: "m1",
        from: "Fixture Billing",
        subject: "Your invoice for the period is ready",
        time: "12:29",
        preview: "The invoice for the period is attached",
        selected: opts.selected,
        actions,
      }),
    );
  });
  const wrapper = host.querySelector<HTMLElement>(".row-actions");
  const band = host.querySelector<HTMLElement>(".row-actions-in");
  const row = host.querySelector<HTMLElement>(".row");
  expect(wrapper, "no `.row-actions` wrapper rendered").not.toBeNull();
  expect(band, "no `.row-actions-in` band rendered").not.toBeNull();
  expect(row, "no row button rendered").not.toBeNull();
  return { wrapper: wrapper!, band: band!, row: row! };
}

describe("no backdrop, because the controls stand clear of the row", () => {
  it("no rule paints a gradient in the slot, in any media context", () => {
    const painted = all
      .filter((b) => /linear-gradient/.test(b.body))
      .filter((b) => subjects(b.selector).some((s) => isWrapper(s) || isBand(s)))
      .map((b) => `${b.media ? `@media ${b.media} ` : ""}${b.selector}`);
    expect(painted, "a backdrop is painted in the slot — it can only cover the row beside it")
      .toEqual([]);
  });

  it("`.row-actions-in` keeps no box of its own — it cannot reach back over the row", () => {
    const own = all.filter((b) => b.selector === ".row-actions-in");
    expect(own.length, "no `.row-actions-in` rule in row.css").toBeGreaterThan(0);
    for (const b of own)
      expect(b.body, "`.row-actions-in` was given a box of its own — it can reach the row again")
        .not.toMatch(/(?:^|[;{\s])(?:position|top|bottom|height|inset)\s*:/);
    const wrapper = all.find((b) => b.selector === ".row-actions");
    expect(wrapper?.body, "the slot is out of flow again — it stops being a column of its own")
      .not.toMatch(/position:\s*(absolute|fixed)/);
  });

  it("a touch screen still shows the controls at rest — and now that costs the row nothing", () => {
    // A press on a phone raises the reading sheet, so selection cannot be how the controls are
    // revealed: they stand, by design (`.scn-act` under `@media (hover: none)`, app.css). With
    // the slot reserved, standing controls no longer sit on anything.
    const appCss = bare("apps/webapp/app/app.css");
    const media = /@media\s*\(\s*hover:\s*none\s*\)\s*\{([\s\S]*?\.scn-act[\s\S]*?)\}\s*\}/.exec(appCss);
    expect(media, "no `@media (hover: none)` block reveals the controls").not.toBeNull();
    expect(media![1], "the standing controls lost their reveal").toMatch(/opacity:\s*1/);
  });
});

describe("the rendered row keeps its controls outside the button", () => {
  it("the actions render inside `.row-actions-in`, a SIBLING of the row button", () => {
    const { wrapper, band, row } = paint();
    expect(band.parentElement, "the band is not the wrapper's child").toBe(wrapper);
    expect(band.querySelector(".scn-act"), "the controls are not inside the slot").not.toBeNull();
    expect(wrapper.querySelector(":scope > .scn-act"), "a control escaped the slot").toBeNull();
    // `role="option"` takes no interactive descendants, and a <button> inside a <button> is a
    // parse error the browser resolves by hoisting the inner one out.
    expect(row.querySelector("button"), "a control was nested inside the row button").toBeNull();
    expect(row.parentElement, "the row and the slot are not siblings").toBe(wrapper.parentElement);
  });

  it("neither box is painted, in any state, whatever the catalogue calls the control", () => {
    for (const label of ["Accept", "Übernehmen"]) {
      for (const selected of [false, true]) {
        const { wrapper, band } = paint({ selected, label });
        expect(band.textContent, "the label did not render").toBe(label);
        expect(getComputedStyle(band).backgroundImage, `a fade behind "${label}"`)
          .not.toMatch(/linear-gradient/);
        expect(getComputedStyle(wrapper).backgroundImage, "the slot is painted").not.toMatch(
          /linear-gradient/,
        );
        root?.unmount();
        root = null;
        host?.remove();
        host = null;
        document.head.querySelector("#row-css")?.remove();
      }
    }
  });
});

describe("one rule, both faces", () => {
  it("no other stylesheet re-declares the row controls' background", () => {
    const others = [
      "packages/tokens/src/faces.css",
      "packages/tokens/src/ohmarchy.css",
      "apps/webapp/app/app.css",
    ];
    for (const p of others) {
      for (const b of blocks(bare(p))) {
        if (!subjects(b.selector).some((s) => isWrapper(s) || isBand(s))) continue;
        expect(b.body, `${p} re-declares the row controls' background — the faces have drifted`)
          .not.toMatch(/(?:^|[;{\s])background(?:-image|-color)?\s*:/);
      }
    }
  });
});
