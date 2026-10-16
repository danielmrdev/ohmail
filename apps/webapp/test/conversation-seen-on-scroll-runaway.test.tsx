/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, installShellEnv, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";
import { key, mountThread, msg, openTheRow, patches, settle } from "./fixtures/thread-read-shell.js";
import { liveReaderSeenScrollers } from "../app/shell/reader-seen";

/**
 * SCROLL-TO-READ IN THE SHIPPED SHELL WRITES ONLY WHAT A PERSON SCROLLED THROUGH — the
 * class, guarded at the reader. A six-member thread opened at its newest: a ResizeObserver tick,
 * `j`, a bare `scroll` and ten seconds write nothing beyond the open's own glance; a wheel that
 * carries p1-p3's ends above the reading line writes ONE glance over exactly those three after the
 * 400 ms batch. The core listens on the reading column's own scroller and is new for every open.
 * Mutations: the attribution gate dropped, the line at 1.0, the scroller taken from `.conv`, the
 * core kept across opens — each red here.
 */

const rects = new Map<string, { top: number; bottom: number }>();
const observers: Array<() => void> = [];
const realRect = Element.prototype.getBoundingClientRect;

const col = (): HTMLElement => document.querySelector<HTMLElement>(".read-col")!;
const glances = () => patches.filter((p) => p.via === "glance");
const place = (ids: string[], from: number, size = 200): void => {
  ids.forEach((id, i) => rects.set(id, { top: from + i * size, bottom: from + (i + 1) * size }));
};
const scrollColBy = async (dy: number): Promise<void> => {
  for (const r of rects.values()) { r.top -= dy; r.bottom -= dy; }
  await act(async () => { col().dispatchEvent(new Event("scroll")); });
};
const wheel = async (): Promise<void> => {
  await act(async () => { col().dispatchEvent(new Event("wheel", { bubbles: true })); });
};

beforeAll(async () => {
  await import("../app/shell/AppShell.js");
  await import("@ohmail/ui");
}, 120_000);
beforeEach(() => {
  installShellEnv();
  window.location.hash = "#/ohbox";
  rects.clear();
  observers.length = 0;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const id = (this as HTMLElement).dataset?.convId;
    const r = id !== undefined ? rects.get(id) : this.classList.contains("read-col") ? { top: 0, bottom: 1000 } : undefined;
    if (!r) return realRect.call(this);
    return { top: r.top, bottom: r.bottom, left: 0, right: 600, width: 600, height: r.bottom - r.top, x: 0, y: r.top, toJSON: () => ({}) } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains("read-col") ? 1000 : 0; },
  });
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    constructor(private cb: () => void) { observers.push(() => this.cb()); }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});
afterEach(async () => {
  await teardownShellEnv();
  Element.prototype.getBoundingClientRect = realRect;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  delete (globalThis as Record<string, unknown>).ResizeObserver;
});

const SIX = ["p1", "p2", "p3", "p4", "p5", "p6"];
async function openSix(): Promise<void> {
  place(SIX, 400);
  await openTheRow(await mountThread(SIX.map((id, i) => msg(id, i * 10))));
  expect(document.querySelector('.read-col [aria-current="true"]')?.getAttribute("data-conv-id"), "opened at the newest").toBe("p6");
}

describe("nothing but a person's scroll reads a sibling", () => {
  it("the anchor, a ResizeObserver tick, j, a bare scroll and 10 s write the open's glance only", async () => {
    await openSix();
    expect(liveReaderSeenScrollers(), "the core reads the reading column's own scroller").toEqual([col()]);
    await act(async () => { for (const tickObserver of observers) tickObserver(); });
    await scrollColBy(300);
    await key("j");
    await scrollColBy(300);
    await tick(10_000);
    await settle();
    expect(glances().map((p) => p.ids)).toEqual([["p6"]]);
  }, 30_000);

  it("the control: a wheel carrying p1-p3 past the line writes ONE glance over them, p4 absent", async () => {
    await openSix();
    await wheel();
    await scrollColBy(750);
    expect(glances().length, "nothing before the batch's quiet window").toBe(1);
    await tick(400);
    await settle();
    expect(glances().map((p) => p.ids)).toEqual([["p6"], ["p1", "p2", "p3"]]);
    expect(document.querySelector('.read-col article.pm[data-conv-id="p2"]')?.hasAttribute("data-unseen")).toBe(false);
    expect(document.querySelector('.read-col article.pm[data-conv-id="p4"]')?.hasAttribute("data-unseen")).toBe(true);
  }, 30_000);

  it("a wheel in one conversation does not carry into the next one opened", async () => {
    place(SIX, 400);
    place(["q1", "q2", "q3"], 400);
    const host = await mountThread([
      ...SIX.map((id, i) => msg(id, 100 + i * 10)),
      ...["q1", "q2", "q3"].map((id, i) => msg(id, i, { threadId: "U" })),
    ]);
    await openTheRow(host);
    await wheel();
    await key("j");
    expect(document.querySelector('.read-col [aria-current="true"]')?.getAttribute("data-conv-id"), "j moved to the second conversation").toBe("q3");
    await act(async () => { for (const tickObserver of observers) tickObserver(); });
    await scrollColBy(100);
    await scrollColBy(400);
    await tick(10_000);
    await settle();
    expect(glances().map((p) => p.ids), "the opens' and the dwell's own glances only").toEqual([["p6"], ["q3"]]);
    expect(vi.isFakeTimers()).toBe(true);
  }, 30_000);
});
