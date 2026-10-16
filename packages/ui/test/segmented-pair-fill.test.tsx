/** @vitest-environment jsdom */
/**
 * A SEGMENTED PAIR NEVER STACKS (DESIGN-FOLD-WIDTHS).
 *
 * The away responder's "Who gets a reply" is two options. At 360 (paper) and 390 (ohmarchy's mono)
 * its row form overflowed the card and the control stacked it into a two-line list, which reads as
 * a list and not as a choice between two. A pair whose row overflows now takes the `data-fill` form:
 * still one row, the full width in two equal halves (`seg.css`; the pixels are measured in
 * `apps/webapp/test/settings-polish-geometry.test.tsx`, the mono face included). Three or more
 * options stack as before — the positive control that the stack form was not withdrawn for them.
 *
 * jsdom has no layout, so the decision is driven through a `ResizeObserver` stub over stubbed
 * geometry, as `segmented-control.test.tsx` does.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SegmentedControl } from "@ohmail/ui";

afterEach(cleanup);

let fire: Array<() => void> = [];
const realRO = globalThis.ResizeObserver;
beforeEach(() => {
  fire = [];
  class RO {
    private live: () => void;
    constructor(cb: () => void) { this.live = cb; fire.push(cb); }
    observe() {}
    unobserve() {}
    disconnect() { fire = fire.filter((f) => f !== this.live); }
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
});
afterEach(() => { (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realRO; });

const PAIR = [{ id: "known", label: "People I've let in" }, { id: "all", label: "Everyone who writes" }];
const FOUR = [...PAIR, { id: "c", label: "Third" }, { id: "d", label: "Fourth" }];

function mount(options: typeof PAIR, paneWidth: number, segWidth: number) {
  render(
    <div className="set-pane">
      <SegmentedControl options={options} value="known" onChange={() => {}} ariaLabel="Who gets a reply" />
    </div>,
  );
  const el = document.querySelector<HTMLElement>(".seg")!;
  el.parentElement!.style.padding = "0px";
  el.style.padding = "2px";
  el.style.margin = "0px";
  Object.defineProperty(el.parentElement!, "clientWidth", { value: paneWidth, configurable: true, writable: true });
  for (const b of [...el.children]) {
    (b as HTMLElement).getBoundingClientRect = () =>
      ({ width: segWidth, height: 24, top: 0, left: 0, right: segWidth, bottom: 24, x: 0, y: 0, toJSON: () => ({}) });
  }
  return el;
}
const resize = (): void => { act(() => { for (const f of [...fire]) f(); }); };
async function frames(n = 3): Promise<void> {
  for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
}

describe("a two-option control whose row overflows fills the row instead of stacking", () => {
  it("overflowing: data-fill, never data-stack", () => {
    const el = mount(PAIR, 232, 150); // 2 x 150 + 4 = 304 into 232
    resize();
    expect(el.hasAttribute("data-stack"), "the pair stacked into a list").toBe(false);
    expect(el.hasAttribute("data-fill"), "the pair did not take the filled form").toBe(true);
    expect([...el.querySelectorAll("button")].map((b) => b.textContent)).toEqual(PAIR.map((o) => o.label));
  });

  it("fitting: the plain row form, neither attribute", () => {
    const el = mount(PAIR, 600, 150);
    resize();
    expect(el.hasAttribute("data-fill")).toBe(false);
    expect(el.hasAttribute("data-stack")).toBe(false);
  });

  it("comes back to the row form when the room returns — the filled halves are not read as the row's width", async () => {
    const el = mount(PAIR, 232, 150);
    resize();
    expect(el.hasAttribute("data-fill")).toBe(true);
    /* In the filled form the halves are stretched: a reading of them would over-report the row. */
    for (const b of [...el.children]) {
      (b as HTMLElement).getBoundingClientRect = () =>
        ({ width: 300, height: 40, top: 0, left: 0, right: 300, bottom: 40, x: 0, y: 0, toJSON: () => ({}) });
    }
    Object.defineProperty(el.parentElement!, "clientWidth", { value: 600, configurable: true, writable: true });
    resize();
    await frames();
    expect(el.hasAttribute("data-fill"), "a remembered 304px row did not come back into 600px").toBe(false);
  });

  it("POSITIVE CONTROL: four options still stack", () => {
    const el = mount(FOUR, 232, 150);
    resize();
    expect(el.hasAttribute("data-stack")).toBe(true);
    expect(el.hasAttribute("data-fill")).toBe(false);
  });

  it("the stylesheet's filled form is a ROW of equal halves whose labels may wrap", () => {
    const seg = readFileSync(resolve(process.cwd(), "packages/ui/src/primitives/seg.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const fill = /\n\.seg\[data-fill\]\{[^}]*\}/.exec(seg)?.[0] ?? "";
    const btn = /\n\.seg\[data-fill\] button\{[^}]*\}/.exec(seg)?.[0] ?? "";
    expect(fill, "no filled form").not.toBe("");
    expect(fill).not.toContain("flex-direction:column");
    expect(fill).toContain("width:100%");
    expect(btn).toContain("flex:1 1 0");
    expect(btn).toContain("white-space:normal");
  });
});
