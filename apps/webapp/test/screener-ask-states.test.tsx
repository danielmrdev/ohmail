/** @vitest-environment jsdom */
/**
 * THE ASK WEARS ITS STATE — `data-state` on the well, `data-run` on the verb that spends.
 *
 * The view derives both from the fields the hook already publishes (`phase`, `quote`,
 * `notice`), so the dress can never disagree with the words beside it. Hand-built controls, as
 * `screener-progress.test.tsx` builds them: the hook's behaviour is its own suite's; what is
 * under test is the view's reading of the fields it is handed.
 */
import { createElement as h } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import messages from "../messages/en.json";
import { SuggestControl } from "../app/views/ScreenerView";
import type { SuggestBatchControl } from "../app/shell/screener-suggest";
import { settleFirstPaint } from "./_first-paint.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};
const control = (over: Partial<SuggestBatchControl>): SuggestBatchControl => ({
  available: 74, resuggestable: 0, unanswered: 74, mode: "new", pool: 74, sizes: [10, 25, 50, 74], size: 25,
  phase: "ready", quote: null, notice: null, progress: null,
  open: noop, openAgain: noop, choose: noop, confirm: noop, cancel: noop,
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

async function mount(c: SuggestBatchControl): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(SuggestControl, { control: c }),
      }),
    );
  });
  await settleFirstPaint();
  return host;
}

const well = (el: HTMLElement) => el.querySelector(".scn-suggest");
const confirm = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLButtonElement>(".scn-sg-actions .btn")].find((b) => !b.className.includes("ghost"))!;

describe("the ask well's state", () => {
  it("idle: a price on screen, no dress, the confirm pressable", async () => {
    const el = await mount(control({ quote: { senders: 12, credits: 12 } }));
    expect(well(el)!.getAttribute("data-state")).toBe("idle");
    expect(confirm(el).disabled).toBe(false);
    expect(confirm(el).getAttribute("data-run")).toBeNull();
    expect(el.querySelector(".scn-sg-price")!.textContent).toBe("12 senders · 12 credits");
  });

  it("working while the price is being checked — the mark beside the sentence, nothing pressable", async () => {
    const el = await mount(control({ phase: "pricing" }));
    expect(well(el)!.getAttribute("data-state")).toBe("working");
    expect(well(el)!.getAttribute("aria-busy")).toBe("true");
    expect(el.querySelector(".scn-sg-price .spin"), "no waiting mark on the price line").toBeTruthy();
    expect(confirm(el).disabled).toBe(true);
  });

  it("working while the purchase runs — the confirm carries the run and says so", async () => {
    const el = await mount(control({
      phase: "running", size: 50, quote: { senders: 40, credits: 40 },
      notice: "3 of 40 suggested…", progress: { done: 3, total: 40 },
    }));
    expect(well(el)!.getAttribute("data-state")).toBe("working");
    expect(confirm(el).getAttribute("data-run")).toBe("working");
    expect(confirm(el).textContent).toBe("Suggesting…");
    expect(confirm(el).disabled).toBe(true);
    // The count is said once, in the note; the price line stands empty rather than repeating it.
    expect(el.querySelector(".scn-sg-note")!.textContent).toBe("3 of 40 suggested…");
    expect(el.querySelector(".scn-sg-price")!.textContent).toBe("");
    // The rungs cannot be moved under a running purchase.
    for (const rung of el.querySelectorAll<HTMLButtonElement>(".scn-sg-size")) expect(rung.disabled).toBe(true);
  });

  it("refused: the server answered with a sentence and no price", async () => {
    const el = await mount(control({ quote: null, notice: "Stopped — credits ran out." }));
    expect(well(el)!.getAttribute("data-state")).toBe("refused");
    expect(el.querySelector(".scn-sg-note")!.textContent).toBe("Stopped — credits ran out.");
    expect(confirm(el).disabled).toBe(true);
  });

  it("a set priced at zero is idle with a sentence — nothing was refused, there is nothing to buy", async () => {
    const el = await mount(control({ quote: { senders: 0, credits: 0 }, notice: "These senders already have a suggestion." }));
    expect(well(el)!.getAttribute("data-state")).toBe("idle");
    expect(confirm(el).disabled).toBe(true);
  });

  it("the rungs are the segmented control, and the closed control is a capsule beside the apply", async () => {
    const open = await mount(control({ quote: { senders: 12, credits: 12 } }));
    expect(open.querySelector(".seg.scope.scn-sg-sizes")).toBeTruthy();
    const closed = await mount(control({ phase: "closed" }));
    const way = closed.querySelector<HTMLButtonElement>(".scn-sg-rest .btn")!;
    expect(way.textContent).toBe("Suggest…");
    expect(way.className).not.toContain("ghost");
  });
});
