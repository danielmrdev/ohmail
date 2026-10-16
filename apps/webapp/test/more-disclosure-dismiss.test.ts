/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import { MoreMenu } from "../app/shell/MoreMenu";

/**
 * ═══ THE MORE MENU COULD NOT BE DISMISSED BY PRESSING ITS OWN BUTTON ═══════════════════════
 *
 * ── THE SEQUENCE, WHICH IS ONE PRESS AND TWO HANDLERS ───────────────────────────────────────
 *
 * A real pointer press fires `mousedown`, then `mouseup`, then `click`. The menu dismisses on a
 * `mousedown` landing outside itself; the trigger toggles on `click`. The trigger is NOT inside
 * the menu, so pressing the open control ran both halves of the single press:
 *
 *   mousedown → the document listener sees a press outside the menu → onClose() → open = false
 *   click     → the trigger's own toggle → setMenuOpen(o => !o) → open = TRUE again
 *
 * Net effect: nothing. The first thing anybody does to put a menu away is press the button that
 * opened it, and that was the one gesture that could not.
 *
 * ── WHY THE OLD TEST WAS GREEN THROUGH ALL OF IT ────────────────────────────────────────────
 *
 * Because it dispatched `click` alone. A synthetic `click` with no `mousedown` in front of it
 * never reaches the dismissal listener, so the toggle ran once and the menu closed — the correct
 * outcome, reached by a sequence no pointer produces. The test was not weak about the assertion;
 * it was weak about the INPUT, which is the harder kind to see.
 *
 * This file drives the press the way a pointer does. `pointer()` is deliberately the only way it
 * presses anything, so a case here cannot accidentally go back to the easier input.
 *
 * ── AND WHY THE LISTENER IS STILL ON `mousedown` ────────────────────────────────────────────
 *
 * Moving it to `click` also makes this case pass, and it is the wrong fix: the `click` that opens
 * the menu is still travelling when the listener is attached, so a `click` listener races the very
 * press that opened it and closes the menu in the same gesture. The fix is to exclude the anchor,
 * which is what `DatePicker` already does with its own.
 */
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let closes = 0;

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

/**
 * A trigger and the menu it opens, wired exactly as the action bar wires them: the menu is a
 * sibling of the button, the button toggles on `click`, and the menu is handed the button as its
 * anchor. Nothing here is a stand-in for the component under test — `MoreMenu` is the real one.
 */
function Harness({ giveAnchor }: { giveAnchor: boolean }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLButtonElement>(null);
  return h("div", null,
    h("button", {
      ref, type: "button", className: "abar-more", "aria-expanded": open,
      onClick: () => setOpen((o) => !o),
    }, "More"),
    open
      ? h(MoreMenu, {
        items: [{ id: "later", label: "Later", run: () => {} }],
        ariaLabel: "More",
        anchor: giveAnchor ? ref.current : null,
        onClose: () => { closes += 1; setOpen(false); },
      })
      : null);
}

async function mount(giveAnchor = true): Promise<void> {
  await unmount();
  closes = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages: en as never,
      children: h(Harness, { giveAnchor }) }));
  });
}

const trigger = (): HTMLButtonElement => host!.querySelector<HTMLButtonElement>(".abar-more")!;
const menu = (): HTMLElement | null => document.querySelector('[role="menu"]');

/** A press, as a pointing device makes one: down, up, then click. */
async function pointer(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => { closes = 0; });
afterEach(async () => { await unmount(); vi.restoreAllMocks(); });

describe("one press is one dismissal", () => {
  it("THE REGRESSION: pressing the open trigger closes the menu and leaves it closed", async () => {
    await mount();
    await pointer(trigger());
    expect(menu(), "the press did not open the menu").not.toBeNull();
    await pointer(trigger());
    expect(menu(), "the menu reopened in the same press that dismissed it").toBeNull();
  });

  it("and the dismissal listener does not fire at all for a press on the trigger", async () => {
    /* The outcome above can be reached by two wrongs cancelling — the listener closing and the
       toggle reopening — so the MECHANISM is asserted too: the anchor press belongs to the
       toggle alone, and `onClose` is never called for it. */
    await mount();
    await pointer(trigger());
    const before = closes;
    await pointer(trigger());
    expect(closes, "the document listener claimed a press that belongs to the trigger")
      .toBe(before);
  });

  it("a press anywhere else still dismisses", async () => {
    await mount();
    await pointer(trigger());
    expect(menu()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(menu(), "an outside press no longer dismisses — the anchor exclusion is too wide")
      .toBeNull();
    expect(closes).toBe(1);
  });

  it("a press inside the menu does not dismiss it either", async () => {
    await mount();
    await pointer(trigger());
    const inside = document.querySelector<HTMLElement>('[role="menuitem"]')!;
    await act(async () => {
      inside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(menu(), "pressing an item dismissed the menu before the item could run").not.toBeNull();
  });

  it("WITHOUT AN ANCHOR the old behaviour is still available, and still wrong for a trigger", async () => {
    /* The counter-case that says the exclusion is what fixes this rather than something else in
       the same commit. `anchor: null` is a legitimate configuration — a menu whose opener this
       component cannot reach — and over a trigger it reproduces the defect exactly. */
    await mount(false);
    await pointer(trigger());
    expect(menu()).not.toBeNull();
    await pointer(trigger());
    expect(menu(), "with no anchor the press should still cancel itself out").not.toBeNull();
  });
});

describe("THE OLD INPUT — why this was green for as long as it was", () => {
  it("a bare `click`, with no mousedown in front of it, closes the menu either way", async () => {
    /* Dispatched exactly as the existing suite does. It passes against the fixed code AND against
       the defect, because it never reaches the dismissal listener — which is what made the report
       impossible to see from the suite. Kept as the record of that, not as a guard. */
    await mount(false);
    await act(async () => {
      trigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(menu()).not.toBeNull();
    await act(async () => {
      trigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(menu(), "even unanchored, a click-only press closes it — no mousedown, no listener")
      .toBeNull();
  });
});
