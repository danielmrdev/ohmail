import { describe, expect, it } from "vitest";
import { notOrganizingYet as core } from "../../../packages/core/src/reader-refusal.js";
import { noneOrganized, noneOrganizedWhy, notOrganizingYet as phone, type NotOrganizingFacts } from "../src/ui/not-organizing";

/**
 * THE PHONE'S TWIN ANSWERS AS CORE DOES over every row shape the phone's wire can carry (`net/mailboxes.ts`), so the
 * Screener's "not organizing yet" stands on the phone exactly where it stands on the web. The phone has no consent
 * absence (the wire folds it into `null`) and no lease-unread flag, which is why those two arms are core's alone.
 */
const fresh: NotOrganizingFacts = {
  status: "connected", organizerRole: "reader", organizeConsentedAt: null, organizedBy: null, organizerState: null,
};
const TABLE: [string, NotOrganizingFacts, boolean][] = [
  ["fresh reader", fresh, true],
  ["lapsed holder", { ...fresh, organizedBy: { kind: "local", name: "Laptop" }, organizerState: "stopped" }, true],
  ["blank-named holder", { ...fresh, organizedBy: { kind: null, name: "  " }, organizerState: "held" }, true],
  ["consented", { ...fresh, organizeConsentedAt: "2026-10-09T10:00:00.000Z" }, false],
  ["organizer", { ...fresh, organizerRole: "organizer" }, false],
  ["role unknown", { ...fresh, organizerRole: null }, false],
  ["live holder", { ...fresh, organizedBy: { kind: "cloud", name: null }, organizerState: "held" }, false],
  ["holder not looked yet", { ...fresh, organizedBy: { kind: null, name: "Office" }, organizerState: null }, false],
  ["removed", { ...fresh, status: "disabled" }, false],
];

describe("the phone's notOrganizingYet twin", () => {
  for (const [name, row, want] of TABLE) {
    it(`${name}: ${want}, and core agrees`, () => {
      expect(phone(row)).toBe(want);
      expect(core(row)).toBe(want);
    });
  }

  it("the Screener's hint gives way only where every live mailbox is one", () => {
    expect(noneOrganized([fresh])).toBe(true);
    expect(noneOrganized([fresh, { ...fresh, status: "disabled", organizeConsentedAt: "x" }])).toBe(true);
    expect(noneOrganized([fresh, { ...fresh, organizerRole: "organizer", organizeConsentedAt: "x" }])).toBe(false);
    expect(noneOrganized([]), "no mailbox read is no claim").toBe(false);
  });

  it("a consented mailbox nothing holds is not screened either, and says why; a live holder or an organizer is", () => {
    const consented = { ...fresh, organizeConsentedAt: "2026-10-09T10:00:00.000Z" };
    expect(noneOrganizedWhy([consented]), "a hand-back read as screened").toBe("stopped");
    expect(noneOrganizedWhy([{ ...consented, organizedBy: { kind: "mobile", name: "Pixel" }, organizerState: "stopped" }])).toBe("stopped");
    expect(noneOrganizedWhy([fresh])).toBe("never_agreed");
    expect(noneOrganizedWhy([fresh, consented]), "a mix is said in the general words").toBe("stopped");
    expect(noneOrganizedWhy([{ ...consented, organizedBy: { kind: "local", name: "Laptop" }, organizerState: "held" }])).toBeNull();
    expect(noneOrganizedWhy([consented, { ...consented, organizerRole: "organizer" }])).toBeNull();
  });
});
