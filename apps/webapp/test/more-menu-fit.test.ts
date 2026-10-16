/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fitUpwardMenu } from "../app/shell/MoreMenu";

/**
 * ═══ THE READER'S MENU STAYS INSIDE THE VIEWPORT ═══════════════════════════════════════
 *
 * The bar's menu opens upward, and a short message on a phone parked the bar high enough that
 * the menu's top left the screen: "Later" unreachable at 390 and 412, the top edge cut at 360
 * (LAYOUT-SWEEP, 2026-10-05). `fitUpwardMenu` is the decision: flip DOWN when the room below the
 * bar holds the menu, else cap the menu to the room above with its own scroll; a menu already on
 * screen, and the forms that are not `bottom`-anchored, are left alone. jsdom lays nothing out,
 * so the boxes are planted; the stylesheet half (`.mmenu-down`) is pinned below.
 *
 * Mutation: return `{ down: false, maxHeight: null }` unconditionally — the first two arms red.
 */

const VH = 780;
let made: HTMLElement[] = [];
afterEach(() => { for (const el of made) el.remove(); made = []; });

function plant(opts: { top: number; height: number; barTop: number; barBottom: number; position?: string; bottom?: string }) {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: VH });
  const bar = document.createElement("div");
  bar.className = "abar";
  bar.getBoundingClientRect = () => ({ top: opts.barTop, bottom: opts.barBottom, left: 0, right: 300, width: 300, height: opts.barBottom - opts.barTop, x: 0, y: opts.barTop, toJSON() {} }) as DOMRect;
  const anchor = document.createElement("button");
  bar.append(anchor);
  const menu = document.createElement("div");
  menu.className = "mmenu";
  menu.style.position = opts.position ?? "absolute";
  menu.style.bottom = opts.bottom ?? "100%";
  menu.getBoundingClientRect = () => ({ top: opts.top, bottom: opts.top + opts.height, left: 0, right: 200, width: 200, height: opts.height, x: 0, y: opts.top, toJSON() {} }) as DOMRect;
  Object.defineProperty(menu, "scrollHeight", { configurable: true, value: opts.height });
  bar.append(menu);
  document.body.append(bar);
  made.push(bar);
  return { menu, anchor };
}

describe("fitUpwardMenu — flip, cap, scroll, never clip", () => {
  it("the 412 cell: a 340px menu over a bar at y 300 overshoots the top and flips DOWN (room below holds it)", () => {
    const { menu, anchor } = plant({ top: -48, height: 340, barTop: 300, barBottom: 344 });
    expect(fitUpwardMenu(menu, anchor)).toEqual({ down: true, maxHeight: null });
  });
  it("the 360 cell: no room below either — the menu keeps its place, capped to the room above, scrolling inside", () => {
    // bar at y 250; below it 780 − 10 − 258 = 512 < 560 of menu; above it 250 − 8 − 10 = 232
    const { menu, anchor } = plant({ top: -318, height: 560, barTop: 250, barBottom: 294 });
    expect(fitUpwardMenu(menu, anchor)).toEqual({ down: false, maxHeight: 232 });
  });
  it("a menu already on screen is left alone (the ordinary upward case)", () => {
    const { menu, anchor } = plant({ top: 400, height: 300, barTop: 708, barBottom: 752 });
    expect(fitUpwardMenu(menu, anchor)).toEqual({ down: false, maxHeight: null });
  });
  it("a form that is not bottom-anchored (the header's, the in-flow one) is never flipped or capped", () => {
    const { menu, anchor } = plant({ top: -48, height: 340, barTop: 300, barBottom: 344, position: "static", bottom: "auto" });
    expect(fitUpwardMenu(menu, anchor)).toEqual({ down: false, maxHeight: null });
  });
  it("the stylesheet carries the flipped form, and only that form re-anchors to the top", () => {
    const css = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/action-bar.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.mmenu\.mmenu-down \{\s*bottom: auto;\s*top: calc\(100% \+ 8px\);\s*\}/);
    expect(css).toMatch(/\.mmenu \{[^}]*bottom: calc\(100% \+ 8px\);/);
  });
});
