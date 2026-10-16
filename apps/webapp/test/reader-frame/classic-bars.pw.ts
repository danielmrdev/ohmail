/**
 * The first hypothesis, held under test where scroll bars take width. A rigid 600px
 * mail in a 600px pane is scaled, so a bar that appears narrows the column and shortens the mail.
 * (The pane was 560px until a column under 480px became a reflowed one: its barred column, 477px,
 * now lays the mail out at scale 1, so the scaled subject this file is about is not there.)
 * Between the heights fitted with and without the bar that is a loop unless the probe's reading
 * ignores the current bar state. Every pane height in the band must be idle after settling, at
 * the height read under the probe (no bar there), whatever bar the pane shows afterwards.
 */
import { expect, test } from "@playwright/test";
import { counters, frames, geometry, openHarness, reset } from "./rig";

test("no pane height between the two fitted heights keeps measuring", async ({ page }) => {
  await openHarness(page, { fx: "rigid", w: 600, h: 3000 });
  await frames(page, 20);
  const wide = await geometry(page);
  expect(wide.reflow, "the fixture must be rigid, or nothing is scaled").toBe(false);

  // The bar held on, so the reading is taken at the narrow column: the positive control.
  await page.evaluate(() => { document.getElementById("pane")!.style.overflowY = "scroll"; });
  await frames(page, 20);
  const narrow = await geometry(page);
  expect(narrow.barWidth, "no classic scroll bar here, so this arm measures nothing").toBeGreaterThan(0);
  await page.evaluate(() => { document.getElementById("pane")!.style.overflowY = ""; });
  await frames(page, 20);
  expect(narrow.frameHeight, "the bar did not narrow the scaled mail").toBeLessThan(wide.frameHeight);

  const from = narrow.chrome + narrow.frameHeight;
  const to = wide.chrome + wide.frameHeight;
  expect(to - from, "control: the band is too narrow to sweep").toBeGreaterThanOrEqual(8);
  expect(narrow.chrome + 600, "under the probe the pane must not overflow").toBeLessThan(from);
  const moving: Array<{ pane: number; writes: number; height: number }> = [];
  for (let h = from; h <= to; h += 2) {
    await page.evaluate((px) => { document.getElementById("pane")!.style.height = `${px}px`; }, h);
    await frames(page, 20);
    await reset(page);
    await frames(page, 60);
    const c = await counters(page);
    const height = (await geometry(page)).frameHeight;
    if (c.styleWrites > 0 || height !== wide.frameHeight) moving.push({ pane: h, writes: c.styleWrites, height });
  }
  expect(moving, "a pane height kept the frame measuring, or left it at a bar-dependent height")
    .toEqual([]);
});
