/**
 * THE COLUMN DECIDES BEFORE THE FIT DOES. Under 480px of column a mail is REFLOWED at scale 1
 * whatever the classifier said (`measure()` stamps `data-ohmail-reflow="column"` on the live
 * root); 480-699 floors the fit at 0.75. A collapsed News card at a phone width is such a column,
 * and the floor of 0.6 there drew a newsletter as a thumbnail with 8px text. Chromium and WebKit.
 */
import { expect, test } from "@playwright/test";
import { frames, openHarness } from "./rig";

const read = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const f = document.querySelector<HTMLIFrameElement>("#pane iframe")!;
  const root = f.contentDocument!.documentElement;
  const scale = root.hasAttribute("data-ohmail-scaled") ? Number(root.style.getPropertyValue("--ohmail-scale")) : 1;
  const body = parseFloat(getComputedStyle(f.contentDocument!.body).fontSize);
  return { column: f.clientWidth, reflow: root.getAttribute("data-ohmail-reflow"), scale, text: body * scale };
});

for (const fx of ["rigid", "rigid-abs"]) {
  test(`${fx}: a column under 480px reflows at scale 1, never a thumbnail`, async ({ page }) => {
    await openHarness(page, { fx, w: 360, h: 3000 });
    await frames(page, 20);
    const r = await read(page);
    expect(r.column, "the harness column is not narrow — this arm measures nothing").toBeLessThan(480);
    expect(r.reflow).toBe("column");
    expect(r.scale).toBe(1);
    expect(r.text, "the mail's text is drawn under 13px").toBeGreaterThanOrEqual(13);
  });
}

test("a 480-699 column fits a rigid mail no smaller than 0.75, and gives the column's reflow back", async ({ page }) => {
  await openHarness(page, { fx: "rigid-abs", w: 600, h: 3000 });
  await frames(page, 20);
  const mid = await read(page);
  expect(mid.column).toBeGreaterThanOrEqual(480);
  expect(mid.reflow, "a mid column is reflowed — the classifier's rigid answer was overridden").toBeNull();
  // Positive control: the scale path is live in this harness (a 900px canvas in a ~530px column).
  expect(mid.scale).toBeLessThan(1);
  expect(mid.scale).toBeGreaterThanOrEqual(0.75);
  // Narrow, then wide again: the column's own answer is taken back off.
  await page.evaluate(() => { document.getElementById("pane")!.style.width = "360px"; });
  await frames(page, 30);
  expect((await read(page)).reflow).toBe("column");
  await page.evaluate(() => { document.getElementById("pane")!.style.width = "600px"; });
  await frames(page, 30);
  const back = await read(page);
  expect(back.reflow).toBeNull();
  expect(back.scale).toBeGreaterThanOrEqual(0.75);
});
