/**
 * A LINK IN A MESSAGE FRAME, IN A REAL ENGINE. First, a listener the parent puts on the frame's
 * document runs in Chromium and never in WebKit (the desktop window on macOS and Linux), with an
 * `allow-scripts` twin as the control that WebKit's listener is observable at all. Then, with the
 * shipped wiring (no frame listener) every click is exactly ONE new-window request carrying the
 * href, in both engines — the request the desktop shell's `popup_route` answers — and neither the
 * app nor the frame moves. Control: a parent-document `_blank` anchor is one request, so a zero
 * reads as a zero.
 */
import { expect, test } from "@playwright/test";
import { LINKS, ORIGIN, frameLink, markerCount, openHarness, settle } from "./rig";

const BLOCKED = "Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set.";

test.describe("a parent-installed listener on the frame's document", () => {
  for (const link of LINKS) {
    test(`runs in chromium only — ${link.href.split(":")[0]} (${link.text})`, async ({ context, browserName }) => {
      const rig = await openHarness(context, browserName, "mode=listener");
      await frameLink(rig, link.text).click();
      await settle(rig.page);
      const seen = await rig.page.evaluate(() => window.__links);
      if (browserName === "webkit") {
        expect(seen.raw, "WebKit ran a listener in a frame sandboxed without scripts").toEqual([]);
        expect(seen.invoked).toEqual([]);
        expect(rig.console).toContain(BLOCKED);
        // Nothing cancelled the click, so it became the new-window request.
        expect(rig.windows).toEqual([link.href]);
      } else {
        expect(seen.raw).toEqual([link.href]);
        expect(seen.invoked).toEqual(link.href.startsWith("https:") ? [link.href] : []);
        // The listener cancelled it: the request the shell's door would answer never exists.
        expect(rig.windows).toEqual([]);
      }
      expect(rig.page.url()).toBe(`${ORIGIN}/harness.html?mode=listener`);
      expect(await markerCount(rig)).toBe(1);
    });

    test(`the control: with allow-scripts the listener runs in both — ${link.href.split(":")[0]} (${link.text})`, async ({ context, browserName }) => {
      const rig = await openHarness(context, browserName, "mode=listener&scripts=1");
      await frameLink(rig, link.text).click();
      await settle(rig.page);
      const seen = await rig.page.evaluate(() => window.__links);
      expect(seen.sandbox).toContain("allow-scripts");
      expect(seen.raw, `${browserName}'s listener was not observable even with scripts allowed`).toEqual([link.href]);
    });
  }
});

test.describe("the shipped wiring", () => {
  for (const link of LINKS) {
    test(`one new-window request carrying the href — ${link.href.split(":")[0]} (${link.text})`, async ({ context, browserName }) => {
      const rig = await openHarness(context, browserName, "mode=product");
      await frameLink(rig, link.text).click();
      await settle(rig.page);
      expect(rig.windows, `${browserName} did not make exactly one request for ${link.href}`).toEqual([link.href]);
      const seen = await rig.page.evaluate(() => window.__links);
      expect(seen.raw).toEqual([]);
      expect(rig.page.url()).toBe(`${ORIGIN}/harness.html?mode=product`);
      expect(await markerCount(rig), "the click navigated the frame").toBe(1);
    });
  }

  test("the control: a parent-document _blank anchor is one request", async ({ context, browserName }) => {
    const rig = await openHarness(context, browserName, "mode=product");
    await rig.page.locator("#parent-control").click();
    await settle(rig.page);
    expect(rig.windows).toEqual(["https://control.test/parent"]);
  });
});
