/** @vitest-environment jsdom */
/**
 * GEOMETRY UNDER THE WEB DOOR'S TEXT SIZE: viewport reads divided by the zoom stamped on <html>,
 * and the very same objects where none is (the default size, the desktop window).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cssPoint, cssRect, cssViewport, uiZoom } from "../src/ui-zoom.js";

const html = (): HTMLElement => document.documentElement;
afterEach(() => html().removeAttribute("style"));

function boxAt(rect: { x: number; y: number; width: number; height: number }): HTMLElement {
  const el = document.createElement("div");
  const r = { ...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
  el.getBoundingClientRect = () => ({ ...r, toJSON: () => r }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

describe("uiZoom", () => {
  it("is 1 with nothing stamped, the stamp with one, and 1 for a nonsense stamp", () => {
    expect(uiZoom()).toBe(1);
    html().style.setProperty("--ui-zoom", "1.25");
    expect(uiZoom()).toBe(1.25);
    html().style.setProperty("--ui-zoom", "0");
    expect(uiZoom()).toBe(1);
  });
});

describe("the CSS-px readers", () => {
  it("hand back the browser's own rect untouched at no zoom", () => {
    const el = boxAt({ x: 50, y: 100, width: 250, height: 125 });
    const rect = el.getBoundingClientRect();
    el.getBoundingClientRect = () => rect;
    expect(cssRect(el)).toBe(rect);
    expect(cssPoint({ clientX: 30, clientY: 40 })).toEqual({ x: 30, y: 40 });
    expect(cssViewport()).toEqual({ width: window.innerWidth, height: window.innerHeight });
  });

  it("divide every viewport read by the stamped zoom", () => {
    html().style.setProperty("--ui-zoom", "1.25");
    const el = boxAt({ x: 50, y: 100, width: 250, height: 125 });
    expect(cssRect(el)).toEqual({ top: 80, left: 40, right: 240, bottom: 180, width: 200, height: 100, x: 40, y: 80 });
    expect(cssPoint({ clientX: 125, clientY: 250 })).toEqual({ x: 100, y: 200 });
    expect(cssViewport()).toEqual({ width: window.innerWidth / 1.25, height: window.innerHeight / 1.25 });
  });
});
