import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import messages from "../messages/en.json";

/**
 * THE BAR MEASURES THE READ SWITCH AT ITS WIDEST FACE, in a real engine. The density copy used to
 * hold the face on screen, so a read flip changed the switch's width and the greedy admission
 * re-seated Tag at 1440 (the LOOK frames). The measure row now stacks the three
 * whole faces in one grid cell (`.abar-read-faces`), so its width is the widest face's whatever the
 * switch shows. Headless Chromium over the real stylesheets; the red control drops the grid, the
 * faces lie side by side and the measure reads far past the widest face.
 */
const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
const css = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
const SHEETS = [
  "packages/tokens/src/tokens.css",
  "packages/ui/src/base.css",
  "apps/webapp/app/app.css",
  "apps/webapp/app/shell/action-bar.css",
].map(css).join("\n");
const SOURCE = css("apps/webapp/app/shell/MessagePane.tsx");

const o = messages.ohbox;
const kbd = (k: string): string => `<kbd class="kbd">${k}</kbd>`;
const check = `<svg class="ic abar-check" style="width:13px;height:13px"></svg>`;
const dot = `<span class="abar-dot"></span>`;
const face = (lead: string, label: string, key: string): string =>
  `<button type="button" class="abar-b abar-solo abar-read">${lead}<span class="abar-read-lab">${label}</span>${kbd(key)}</button>`;
const FACES: Array<[string, string, string]> = [[check, o.actionDone, "⇧ i"], [dot, o.actionMarkUnread, "u"], [dot, o.actionMarkRead, "⇧ i"]];
const stacked = `<button type="button" class="abar-b abar-solo abar-read" id="m"><span class="abar-read-faces">`
  + FACES.map(([l, w, k]) => `<span>${l}<span>${w}</span>${kbd(k)}</span>`).join("")
  + `</span><span class="abar-read-lab abar-read-words">${FACES.map(([, w]) => `<span>${w}</span>`).join("")}</span></button>`;

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
beforeAll(async () => { browser = await chromium.launch(); }, 60_000);
afterAll(async () => { await browser?.close(); });

async function widths(extraCss: string): Promise<{ measure: number; faces: number[]; words: number; faceWords: number[] }> {
  const page = await browser!.newPage();
  await page.setContent(`<style>${SHEETS}${extraCss}</style><div class="msg-actions"><div class="abar">`
    + `<div class="abar-row abar-measure" style="position:static;visibility:visible;height:auto;overflow:visible;display:flex;gap:6px">`
    + `${stacked}${FACES.map(([l, w, k]) => face(l, w, k)).join("")}</div></div></div>`);
  const r = await page.evaluate(() => [...document.querySelectorAll(".abar-read")].map((b) => b.getBoundingClientRect().width));
  const words = await page.evaluate(() => [...document.querySelectorAll(".abar-read .abar-read-lab")].map((b) => b.getBoundingClientRect().width));
  await page.close();
  return { measure: r[0]!, faces: r.slice(1), words: words[0]!, faceWords: words.slice(1) };
}

describe("the read switch's measure", () => {
  it("is the widest whole face, and its words the widest face's words", async () => {
    const { measure, faces, words, faceWords } = await widths("");
    expect(Math.abs(measure - Math.max(...faces)), `measure ${measure} faces ${faces.join(",")}`).toBeLessThan(0.75);
    expect(Math.abs(words - Math.max(...faceWords)), `words ${words} of ${faceWords.join(",")}`).toBeLessThan(0.75);
  }, 60_000);

  it("THE RED CONTROL: without the grid the measure reads the faces side by side", async () => {
    const { measure, faces } = await widths(".abar-read-faces{display:inline-flex}");
    expect(measure).toBeGreaterThan(Math.max(...faces) + 40);
  }, 60_000);

  it("is what the bar's measure row renders", () => {
    expect(SOURCE).toContain('<span className="abar-read-faces">');
    expect(SOURCE).toContain('<span className="abar-read-lab abar-read-words">');
  });
});
