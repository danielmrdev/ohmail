/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { SettingsSection, ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

import { SettingsView } from "../app/views/SettingsView";

/**
 * ═══ THE EMPTY HALF-SCREEN ABOVE "DELETE YOUR ACCOUNT" ══════════════════════════════════════
 *
 * ── THE DEFECT, AND ITS MECHANISM ───────────────────────────────────────────────────────────
 *
 * Settings → Account showed the sign-out card, then roughly a nav's height of blank canvas, then
 * the delete card. Nothing was hidden and no rule was wrong.
 *
 * `.set-layout` is a two-column grid — nav (170px) | content (1fr) — and EVERY direct child is a
 * grid item. Account is the one pane that renders TWO `SettingsSection`s (the sign-out card and
 * the delete card), so it put two items into a grid that had already placed the nav:
 *
 *   nav        → auto-placed: row 1, column 1
 *   sign-out   → `grid-column: 2`, auto row → row 1, column 2
 *   delete     → `grid-column: 2`, auto row → column 2 is taken in row 1, so ROW 2
 *
 * A grid row is as tall as the tallest item in it, and the item in row 1 is the ten-entry nav. So
 * the delete card began below the BOTTOM OF THE NAV — the blank space is row 1 continuing past the
 * short sign-out card, exactly as the grid was asked to.
 *
 * ── WHY THE RULE THAT WAS THERE COULD NOT HAVE FIXED IT ─────────────────────────────────────
 *
 * `.set-layout > .set-pane { grid-column: 2 }` was added for the FIRST half of this same
 * mechanism: before it, the second card auto-placed into the NAV's 170px column and sat squeezed
 * underneath it. Pinning the column cured that and could never cure this — a column pin says
 * nothing about rows, and the item it pins is still an item, still auto-placed into the next free
 * row. The two symptoms look unrelated on screen and are one placement.
 *
 * ── THE FIX, AND WHAT THIS FILE PINS ────────────────────────────────────────────────────────
 *
 * The panes are wrapped in ONE element, so the grid has exactly two items — nav and content — and
 * a pane's sections stack inside the wrapper with a flex gap that owes the nav nothing. Both
 * halves are asserted: the DOM shape (a pane of any size is one grid item) and the CSS that makes
 * the wrapper stack rather than inherit the grid's placement.
 *
 * ── MUTATION WATCH ──────────────────────────────────────────────────────────────────────────
 *
 *  · delete the `<div className="set-pane-col">` wrapper from `SettingsView` → the two DOM cases
 *    go red (`.set-layout` gains a third child, and the sections stop being inside a wrapper);
 *  · delete the `.set-pane-col` block from `app.css` → the flex case goes red;
 *  · put `.set-layout > .set-pane { grid-column: 2 }` back → the last case goes red, because that
 *    rule can only matter again if a pane's sections have been let back out into the grid.
 *
 * All four were run; each turned exactly the case named and nothing else.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

let host: HTMLDivElement;
let root: Root;

async function mount(props: Parameters<typeof SettingsView>[0]) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, h(SettingsView, props))),
      }),
    );
  });
}

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

/**
 * The Account pane's shape and nothing else of it: TWO sibling `SettingsSection`s under one
 * fragment, which is what `(product)/mailbox/AccountSection.tsx` returns. The real component is
 * not imported — it is under `(product)`, needs a session and three api-client reads, and none of
 * that is what this file is about. What matters is the count.
 */
const twoCardAccount = h(
  React.Fragment,
  null,
  h(SettingsSection, { className: "acct acct-session", key: "a", children: h("p", null, "Sign out") }),
  h(SettingsSection, { className: "acct", key: "b", children: h("h2", null, "Delete your account") }),
);

const BASE: Parameters<typeof SettingsView>[0] = {
  notifications: null,
  tags: [],
  tagCounts: {},
};

describe("SET — a settings pane is ONE grid item, however many cards it draws", () => {
  it("the Account pane's two cards do not become two grid items", async () => {
    await mount({ ...BASE, accountSection: twoCardAccount, initialPane: "account" });

    const layout = host.querySelector(".set-layout")!;
    expect(layout, "no .set-layout — the harness stopped rendering the settings sheet").toBeTruthy();

    // Both cards are on screen: this is the pane that HAS two, and a fix that dropped one would
    // otherwise satisfy every assertion below.
    expect(host.querySelectorAll(".set-pane")).toHaveLength(2);
    expect(host.textContent).toContain("Delete your account");

    /* THE ASSERTION THE DEFECT FAILS. Two items plus the nav is three children, and the third is
       what the grid gave a second row — sized by the nav standing in the first. */
    expect(
      [...layout.children].map((el) => el.className),
      "the settings grid has grown a third item — a pane's sections are being auto-placed again, " +
        "which is what put the delete card below the bottom of the nav",
    ).toHaveLength(2);
    expect(layout.children[0]!.classList.contains("set-nav")).toBe(true);
    expect(layout.children[1]!.classList.contains("set-pane-col")).toBe(true);
  });

  it("…and every card is inside the wrapper, not beside it", async () => {
    await mount({ ...BASE, accountSection: twoCardAccount, initialPane: "account" });
    const col = host.querySelector(".set-pane-col")!;
    for (const pane of host.querySelectorAll(".set-pane")) {
      expect(col.contains(pane), "a .set-pane escaped the content column").toBe(true);
    }
  });

  it("a one-card pane is unchanged by the wrapper — it was always one item", async () => {
    await mount({ ...BASE, initialPane: "general" });
    const layout = host.querySelector(".set-layout")!;
    expect(layout.children).toHaveLength(2);
    expect(host.querySelectorAll(".set-pane")).toHaveLength(1);
  });
});

/* ── The CSS half. The DOM above only says the cards are siblings in one box; what makes them
      stack under each other rather than inherit a grid placement is this. Read from source and
      with comments stripped, the method `settings-390-reflow.test.ts` uses on the same file for
      the same reason: the prose here quotes the rule it describes. ───────────────────────────── */

const bare = (p: string): string =>
  readFileSync(resolve(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const APP_CSS = bare("apps/webapp/app/app.css");

/** The declarations of the first `selector { … }` block in `css`, or null. */
function blockOf(css: string, selector: string): string | null {
  const at = css.indexOf(selector);
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  if (open < 0 || close < 0) return null;
  return css.slice(open + 1, close);
}

describe("SET — the content column stacks its sections itself", () => {
  it("app.css makes .set-pane-col a flex column with a gap", () => {
    const block = blockOf(APP_CSS, ".set-pane-col {");
    expect(block, "no `.set-pane-col` rule — the cards fall back to normal flow with no gap").toBeTruthy();
    const flat = block!.replace(/\s/g, "");
    expect(flat).toContain("display:flex");
    expect(flat).toContain("flex-direction:column");
    expect(flat).toMatch(/gap:\d/);
  });

  it("…and releases its sections' intrinsic minimum, as the grid items it replaced did", () => {
    // `.set-layout > *` (settings-390-reflow.test.ts) frees the WRAPPER; the sections are now flex
    // items inside it and need the same release, or one nowrap rule row widens the sheet again.
    expect(blockOf(APP_CSS, ".set-pane-col > *")?.replace(/\s/g, "")).toContain("min-width:0");
  });

  it("no `.set-layout > .set-pane` placement rule survives", () => {
    // Its presence would mean a pane's sections are direct grid items again, which is the whole
    // defect: the column pin is the half of it that LOOKS fixed.
    expect(
      APP_CSS.includes(".set-layout > .set-pane"),
      "a `.set-layout > .set-pane` rule is back — sections are being placed by the grid again",
    ).toBe(false);
  });
});
