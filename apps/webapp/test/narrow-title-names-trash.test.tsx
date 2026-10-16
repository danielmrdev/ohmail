/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import messages from "../messages/en.json";
import { S, engineOver, msg, setup, shell, storeWith, teardown, waitFor } from "./_view-shell";

/**
 * THE NARROW TOP BAR NAMES THE VIEW IT STANDS OVER. Under 1024px the top bar's title is the only
 * name a view has on screen, and Trash was missing from the map it reads, so every Trash visit on
 * a phone-sized window was labelled Ohbox (DESIGN-REVIEW-026-VIEW-SAYS-GONE point 1).
 */
beforeEach(setup);
afterEach(teardown);

const title = (el: HTMLElement) => el.querySelector(".topbar .tb-title")?.textContent ?? "";

/**
 * A SETTINGS SECTION ON A PHONE names itself in the bar and carries the way back; a routed section
 * this surface does not offer — `desktop`, which no browser tab wires — is the list, under the
 * page's name, with no back chip (H1 and LOOK-026 UGLY 4).
 */
describe("a settings section's title and way back on a phone", () => {
  it("an offered section: its name in the bar, the back chip beside it", async () => {
    S.mobile = true;
    const s = await storeWith([msg("m1")]);
    const el = await shell(s, engineOver(s), "#/settings/notifications");
    await waitFor(() => title(el) === messages.settings.notifications, "the section's name in the bar");
    expect(el.querySelector(".topbar .tb-back"), "no way back to the list").not.toBeNull();
  });
  it("an unknown section: the page's name, no back chip, the list standing", async () => {
    S.mobile = true;
    const s = await storeWith([msg("m1")]);
    const el = await shell(s, engineOver(s), "#/settings/desktop");
    await waitFor(() => title(el) === messages.rail.settings, "the page's name in the bar");
    expect(el.querySelector(".topbar .tb-back"), "a back chip to the same word").toBeNull();
    await waitFor(() => el.querySelector(".set-list") != null, "the section list");
  });
});

describe("the narrow top bar's title", () => {
  for (const [hash, want] of [
    ["#/trash", messages.rail.trash],
    ["#/history", messages.rail.history],
    ["#/ohbox", messages.rail.ohbox],
  ] as const) {
    it(`reads ${want} on ${hash}`, async () => {
      const s = await storeWith([msg("m1")]);
      const el = await shell(s, engineOver(s), hash);
      await waitFor(() => title(el) !== "", "the top bar's title");
      expect(title(el)).toBe(want);
    });
  }
});
