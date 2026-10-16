/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fitRowMenu, useRowMenuFit, visibleBand } from "../app/shell/row-menu-fit";

/**
 * ═══ A ROW'S MENU STAYS ON SCREEN ═══════════════════════════════════════════════════════════
 *
 * CELL LAYOUT-WEB read the Screener's destination menu, opened from a lower row at 360x780, ending
 * 21px past the viewport (53px in German); the cut lines were the unsubscribe note. jsdom lays
 * nothing out, so boxes are planted from `data-rect`; the browser read is the layout cell.
 *
 * Mutation: `fitRowMenu` returning `{ up: false, maxHeight: null, scroll: 0 }` unconditionally
 * reddens the flip, scroll, cap and hook arms.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const VH = 780;

describe("fitRowMenu — below, else up, else the list scrolls, else capped to the larger side", () => {
  const band = { top: 0, bottom: VH };
  it("the 360 en cell: a 261px menu under a row ending at 556 would end at 821; the room above holds it, so it opens UP", () => {
    expect(fitRowMenu({ natural: 261, downTop: 560, triggerTop: 520, gap: 4 }, band)).toEqual({ up: true, maxHeight: null, scroll: 0 });
  });
  it("a menu the room below holds stays below (the ordinary case, no inline style)", () => {
    expect(fitRowMenu({ natural: 261, downTop: 300, triggerTop: 260, gap: 4 }, band)).toEqual({ up: false, maxHeight: null, scroll: 0 });
  });
  it("the room below, plus one pixel of rounding, is admitted below; a pixel more is not", () => {
    // below = 780 − 10 − 509 = 261
    expect(fitRowMenu({ natural: 262, downTop: 509, triggerTop: 470, gap: 4 }, band)).toEqual({ up: false, maxHeight: null, scroll: 0 });
    expect(fitRowMenu({ natural: 263, downTop: 509, triggerTop: 470, gap: 4 }, band)).toEqual({ up: true, maxHeight: null, scroll: 0 });
  });
  it("the top row of a 355px list (360 en): neither side holds it, so the list scrolls by the shortfall", () => {
    // list 415..770: below = 770 − 10 − 560 = 200, above = 520 − 4 − 425 = 91, shortfall 61
    const list = { top: 415, bottom: 770 };
    expect(fitRowMenu({ natural: 261, downTop: 560, triggerTop: 520, gap: 4, roomDown: 100 }, list)).toEqual({ up: false, maxHeight: null, scroll: 61 });
    // a list that cannot move that far: capped below, the larger side
    expect(fitRowMenu({ natural: 261, downTop: 560, triggerTop: 520, gap: 4, roomDown: 60 }, list)).toEqual({ up: false, maxHeight: 200, scroll: 0 });
  });
  it("a row the list has already scrolled high: the list scrolls back by the smaller shortfall and the menu opens up", () => {
    // list 415..770: below = 770 − 10 − 704 = 56 (lack 205), above = 640 − 4 − 425 = 211 (lack 50)
    const list = { top: 415, bottom: 770 };
    expect(fitRowMenu({ natural: 261, downTop: 704, triggerTop: 640, gap: 4, roomDown: 300, roomUp: 42 }, list)).toEqual({ up: false, maxHeight: null, scroll: 205 });
    expect(fitRowMenu({ natural: 261, downTop: 704, triggerTop: 640, gap: 4, roomDown: 100, roomUp: 60 }, list)).toEqual({ up: true, maxHeight: null, scroll: -50 });
    expect(fitRowMenu({ natural: 261, downTop: 704, triggerTop: 640, gap: 4, roomDown: 300, roomUp: 60 }, list)).toEqual({ up: true, maxHeight: null, scroll: -50 });
  });
  it("neither side holds it: capped to the larger side, so it scrolls and never leaves the screen", () => {
    // below = 780 − 10 − 420 = 350; above = 380 − 4 − 10 = 366
    expect(fitRowMenu({ natural: 500, downTop: 420, triggerTop: 380, gap: 4 }, band)).toEqual({ up: true, maxHeight: 366, scroll: 0 });
    // below = 780 − 10 − 300 = 470; above = 260 − 4 − 10 = 246
    expect(fitRowMenu({ natural: 500, downTop: 300, triggerTop: 260, gap: 4 }, band)).toEqual({ up: false, maxHeight: 470, scroll: 0 });
  });
  it("a scroller's edge is the bound, not the viewport's", () => {
    expect(fitRowMenu({ natural: 261, downTop: 300, triggerTop: 260, gap: 4 }, { top: 100, bottom: 500 })).toEqual({ up: false, maxHeight: 190, scroll: 0 });
  });
});

const realRect = Element.prototype.getBoundingClientRect;
const planted = (el: Element): DOMRect => {
  const [top, bottom] = (el.getAttribute("data-rect") ?? "0,0").split(",").map(Number);
  return { top, bottom, left: 0, right: 300, width: 300, height: bottom - top, x: 0, y: top, toJSON() {} } as DOMRect;
};
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  Element.prototype.getBoundingClientRect = realRect;
});

function Harness({ rowRect, natural, scroller }: { rowRect: string; natural: number; scroller?: string }) {
  const menu = React.useRef<HTMLDivElement>(null);
  const more = React.useRef<HTMLButtonElement>(null);
  const fit = useRowMenuFit(menu, more, true, 4);
  const [top, bottom] = rowRect.split(",").map(Number);
  return (
    <div data-rect={scroller ?? `0,${VH}`} style={scroller ? { overflowY: "auto" } : undefined}>
      <div className="row-slot" data-rect={rowRect} style={{ position: "relative" }}>
        <button ref={more} data-rect={`${bottom - 36},${bottom - 10}`}>more</button>
        <div
          ref={(el) => {
            if (el) {
              Object.defineProperty(el, "scrollHeight", { configurable: true, value: natural });
              (menu as React.MutableRefObject<HTMLDivElement | null>).current = el;
            }
          }}
          data-testid="menu"
          data-rect={`${bottom + 4},${bottom + 4 + natural}`}
          data-capped={fit.capped || undefined}
          style={fit.style}
        >
          {top}
        </div>
      </div>
    </div>
  );
}

function mount(node: React.ReactElement): HTMLElement {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: VH });
  Element.prototype.getBoundingClientRect = function () { return planted(this); };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host.querySelector<HTMLElement>("[data-testid=menu]")!;
}

describe("useRowMenuFit — the decision reaches the menu's style before the first paint", () => {
  it("a low row's menu is anchored upward on the trigger: bottom = row bottom − trigger top + gap", () => {
    const el = mount(<Harness rowRect="456,556" natural={261} />);
    expect(el.style.top).toBe("auto");
    expect(el.style.bottom).toBe("40px"); // 556 − 520 + 4
    expect(el.hasAttribute("data-capped")).toBe(false);
  });
  it("a high row's menu keeps the stylesheet's downward place (no inline style at all)", () => {
    const el = mount(<Harness rowRect="100,200" natural={261} />);
    expect(el.getAttribute("style")).toBeNull();
  });
  it("a menu no side holds is capped, scrolls inside and says so for the note to lead", () => {
    const el = mount(<Harness rowRect="300,420" natural={600} />);
    expect(el.style.maxHeight).toBe("370px"); // above = 384 − 4 − 10 vs below = 780 − 10 − 424
    expect(el.style.overflowY).toBe("auto");
    expect(el.getAttribute("data-capped")).toBe("true");
  });
  it("visibleBand narrows the viewport by a clipping ancestor and ignores a visible one", () => {
    Element.prototype.getBoundingClientRect = function () { return planted(this); };
    const outer = document.createElement("div");
    outer.style.overflowY = "auto";
    outer.setAttribute("data-rect", "60,700");
    const mid = document.createElement("div");
    mid.setAttribute("data-rect", "0,10");
    outer.append(mid);
    document.body.append(outer);
    expect(visibleBand(mid, VH)).toEqual({ top: 60, bottom: 700, scroller: outer });
    outer.remove();
  });
});

describe("the stylesheet's half", () => {
  it("a capped menu puts its unsubscribe note first, so it is read before any verb", () => {
    const css = readFileSync(resolve(process.cwd(), "apps/webapp/app/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.scn-act-menu\[data-capped\] \.scn-act-unsub \{\s*order: -1;/);
    // The gaps the callers pass are the stylesheet's own.
    expect(css).toMatch(/\.scn-act-menu \{[^}]*top: calc\(100% \+ 4px\);/);
    const rail = readFileSync(resolve(process.cwd(), "packages/ui/src/composites/rail.css"), "utf8");
    expect(rail).toMatch(/\.fmenu\{top:calc\(100% \+ 2px\)/);
  });
});
