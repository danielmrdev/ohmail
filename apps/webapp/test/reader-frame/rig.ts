/**
 * The rig's reads over `window.__rf` (see `harness.tsx`): open the page, wait on the pictures,
 * read the pane's geometry, count over N animation frames. Nothing here writes to the mail
 * except `growBody`, the positive control's one genuine change.
 */
import type { Page } from "@playwright/test";
import { resolve } from "node:path";

/** The built page; `READER_FRAME_OUT` points a run at a mutation arm's bundle. */
export const HARNESS = resolve(
  __dirname, "../../../..", process.env.READER_FRAME_OUT ?? "build/reader-frame", "harness.html",
);

export interface Counters {
  fetches: Record<string, number>;
  held: number;
  probes: number;
  styleWrites: number;
  heights: string[];
  scrollTopWrites: number;
  scrollEvents: number;
}

export interface Geometry {
  reflow: boolean;
  frameHeight: number;
  chrome: number;
  scrollHeight: number;
  clientHeight: number;
  barWidth: number;
}

export async function openHarness(page: Page, q: Record<string, string | number> = {}): Promise<void> {
  const params = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]));
  await page.goto(`file://${HARNESS}?${params.toString()}`);
  await page.waitForFunction(() => window.__rf !== undefined);
  await page.waitForFunction(() => {
    const f = document.querySelector<HTMLIFrameElement>("#pane iframe");
    return !!f && /px$/.test(f.style.height) && f.style.height !== "600px";
  });
}

export async function frames(page: Page, n: number): Promise<void> {
  await page.evaluate((count) => new Promise<void>((done) => {
    let i = 0;
    const step = (): void => { i += 1; if (i >= count) done(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), n);
}

export async function counters(page: Page): Promise<Counters> {
  return page.evaluate(() => {
    const rf = window.__rf;
    return {
      fetches: { ...rf.fetches }, held: rf.held, probes: rf.probes, styleWrites: rf.styleWrites,
      heights: [...rf.heights], scrollTopWrites: rf.scrollTopWrites, scrollEvents: rf.scrollEvents,
    };
  });
}

export async function reset(page: Page): Promise<void> {
  await page.evaluate(() => window.__rf.reset());
}

export async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const pane = document.getElementById("pane")!;
    const f = pane.querySelector<HTMLIFrameElement>("iframe")!;
    return {
      reflow: f.contentDocument?.documentElement.hasAttribute("data-ohmail-reflow") ?? false,
      frameHeight: f.offsetHeight,
      // The pane's CONTENT less the frame, read off the content box: `scrollHeight` is clamped up
      // to the pane's own height when nothing overflows.
      chrome: document.getElementById("mount")!.offsetHeight - f.offsetHeight,
      scrollHeight: pane.scrollHeight,
      clientHeight: pane.clientHeight,
      barWidth: pane.offsetWidth - pane.clientWidth,
    };
  });
}

export async function scrollToEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    const pane = document.getElementById("pane")!;
    pane.scrollTop = pane.scrollHeight;
  });
}

/** A genuine change to the mail's box: a 50px block appended inside the frame's body. */
export async function growBody(page: Page): Promise<void> {
  await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>("#pane iframe")!.contentDocument!;
    const block = doc.createElement("div");
    block.style.height = "50px";
    doc.body.appendChild(block);
  });
}
