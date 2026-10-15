import { describe, expect, it } from "vitest";
import {
  gateKept, holderIsLive, nothingOrganizesWhy, notOrganizingYet, organizerSituation, requestRefusalReason,
  rosterRefusalReason, standingOf,
} from "../src/reader-refusal.js";

/** The decider's table: a LIVE holder is outdated; none, or one whose lease lapsed, is nobody. */
describe("requestRefusalReason", () => {
  const laptop = { kind: "local", name: "Studio laptop" };

  it("a named holder still renewing, or not looked at yet, is organizer_outdated", () => {
    expect(requestRefusalReason({ by: laptop, state: "held" })).toBe("organizer_outdated");
    expect(requestRefusalReason({ by: laptop, state: null })).toBe("organizer_outdated");
    expect(requestRefusalReason({ by: laptop })).toBe("organizer_outdated");
    // Either half names a holder: a kind with no name, a name with no kind.
    expect(requestRefusalReason({ by: { kind: "cloud", name: null }, state: "held" })).toBe("organizer_outdated");
    expect(requestRefusalReason({ by: { kind: null, name: "Office" }, state: "held" })).toBe("organizer_outdated");
  });

  it("a holder whose lease lapsed is no_organizer, whatever it is called", () => {
    expect(requestRefusalReason({ by: laptop, state: "stopped" })).toBe("no_organizer");
    expect(requestRefusalReason({ by: { kind: "cloud", name: null }, state: "stopped" })).toBe("no_organizer");
  });

  it("no holder named at all, or no row, is no_organizer", () => {
    expect(requestRefusalReason({ by: null, state: null })).toBe("no_organizer");
    expect(requestRefusalReason({ by: { kind: null, name: null }, state: "held" })).toBe("no_organizer");
    expect(requestRefusalReason({ by: { kind: null, name: "   " }, state: "held" })).toBe("no_organizer");
    expect(requestRefusalReason(null)).toBe("no_organizer");
    expect(requestRefusalReason(undefined)).toBe("no_organizer");
  });
});

describe("holderIsLive — the liveness both reasons and the Mailboxes pane rest on", () => {
  it("is a named holder whose lease has not lapsed", () => {
    expect(holderIsLive({ by: { kind: "local", name: null }, state: "held" })).toBe(true);
    expect(holderIsLive({ by: { kind: "local", name: null }, state: null })).toBe(true);
    expect(holderIsLive({ by: { kind: "local", name: null }, state: "stopped" })).toBe(false);
    expect(holderIsLive({ by: null, state: "held" })).toBe(false);
    expect(holderIsLive(null)).toBe(false);
  });
});

describe("rosterRefusalReason", () => {
  it("is outdated when any holder is live, and nobody's otherwise", () => {
    const stopped = { by: { kind: "local", name: "Laptop" }, state: "stopped" };
    const live = { by: { kind: "local", name: "Office" }, state: "held" };
    expect(rosterRefusalReason([stopped, live])).toBe("organizer_outdated");
    expect(rosterRefusalReason([stopped, null])).toBe("no_organizer");
    expect(rosterRefusalReason([])).toBe("no_organizer");
  });
});

/**
 * NOTHING SCREENS IT: a reader nobody agreed to and no live holder organizes. Each condition is one arm, so a
 * consented, organizing, held, unlooked or legacy row is never told it is not organized.
 */
describe("notOrganizingYet", () => {
  const fresh = { status: "connected", organizerRole: "reader" as const, organizeConsentedAt: null, organizedBy: null, organizerState: null };

  it("a connected reader with no consent and no holder is not organized yet", () => {
    expect(notOrganizingYet(fresh)).toBe(true);
    expect(notOrganizingYet({ ...fresh, organizerChecked: true })).toBe(true);
  });

  it("a named holder whose lease lapsed organizes nothing either", () => {
    expect(notOrganizingYet({ ...fresh, organizedBy: { kind: "local", name: "Laptop" }, organizerState: "stopped" })).toBe(true);
  });

  it("CONTROL: consent, the organizer role, a live holder, an unread lease, a removal or an absent stamp say nothing", () => {
    expect(notOrganizingYet({ ...fresh, organizeConsentedAt: "2026-10-09T10:00:00.000Z" })).toBe(false);
    expect(notOrganizingYet({ ...fresh, organizerRole: "organizer" })).toBe(false);
    expect(notOrganizingYet({ ...fresh, organizedBy: { kind: "cloud", name: null }, organizerState: "held" })).toBe(false);
    expect(notOrganizingYet({ ...fresh, organizedBy: { kind: null, name: "Office" }, organizerState: null })).toBe(false);
    expect(notOrganizingYet({ ...fresh, organizerChecked: false })).toBe(false);
    expect(notOrganizingYet({ ...fresh, status: "disabled" })).toBe(false);
    const { organizeConsentedAt: _absent, ...legacy } = fresh;
    expect(notOrganizingYet(legacy)).toBe(false);
  });
});

/**
 * ONE ANSWER TO "WHO ORGANIZES THIS MAILBOX". Every member is reached by its own row, the order between
 * members is pinned where two could match, and a pending press carries the state it waits on.
 */
describe("organizerSituation", () => {
  const T = "2026-10-11T04:00:00.000Z";
  const reader = {
    status: "connected", organizerRole: "reader" as const, organizerChecked: true, organizeConsentedAt: T,
    organizedBy: null, organizerState: null, organizerReleasedAt: null, organizerParkedAt: null,
    releaseRequestedAt: null, takeoverAuthorizedAt: null,
  };
  const phone = { kind: "mobile", name: "Pixel", since: T };

  it("this install organizes it, or is stopping, by the role and the standing stop", () => {
    expect(organizerSituation({ ...reader, organizerRole: "organizer" })).toEqual({ kind: "organizing_here" });
    expect(organizerSituation({ ...reader, organizerRole: "organizer", releaseRequestedAt: T })).toEqual({ kind: "stopping_here" });
    // An absent role reads as organizer, the role's default on every surface.
    expect(organizerSituation({ ...reader, organizerRole: undefined })).toEqual({ kind: "organizing_here" });
  });

  it("a live holder organizes it elsewhere, consented or not", () => {
    expect(organizerSituation({ ...reader, organizedBy: phone, organizerState: "held" }))
      .toEqual({ kind: "organized_elsewhere", by: phone });
    expect(organizerSituation({ ...reader, organizeConsentedAt: null, organizedBy: phone, organizerState: null }))
      .toEqual({ kind: "organized_elsewhere", by: phone });
  });

  it("nothing organizes it: never agreed, handed back, or its holder stopped", () => {
    expect(organizerSituation({ ...reader, organizeConsentedAt: null }))
      .toEqual({ kind: "nothing_organizes", why: "never_agreed", lapsed: null });
    expect(organizerSituation({ ...reader, organizerReleasedAt: T }))
      .toEqual({ kind: "nothing_organizes", why: "handed_back", lapsed: null });
    expect(organizerSituation({ ...reader, organizedBy: phone, organizerState: "stopped" }))
      .toEqual({ kind: "nothing_organizes", why: "stopped", lapsed: phone });
    // Consented, nobody recorded, no release: a stand-down whose winner went away.
    expect(organizerSituation(reader)).toEqual({ kind: "nothing_organizes", why: "stopped", lapsed: null });
  });

  it("a holder that stopped after the release is the newer fact; no consent outranks both", () => {
    // The release clears the holder columns, so a holder on the row came after it.
    expect(organizerSituation({ ...reader, organizerReleasedAt: T, organizedBy: phone, organizerState: "stopped" }))
      .toEqual({ kind: "nothing_organizes", why: "stopped", lapsed: phone });
    expect(organizerSituation({ ...reader, organizeConsentedAt: null, organizedBy: phone, organizerState: "stopped" }))
      .toEqual({ kind: "nothing_organizes", why: "never_agreed", lapsed: phone });
  });

  it("parked by the wall, unread, removed, or a build that cannot tell", () => {
    expect(organizerSituation({ ...reader, organizerParkedAt: T, organizerReleasedAt: T })).toEqual({ kind: "parked" });
    expect(organizerSituation({ ...reader, organizerChecked: false })).toEqual({ kind: "unknown" });
    expect(organizerSituation({ ...reader, status: "disabled" })).toEqual({ kind: "unknown" });
    const { organizeConsentedAt: _absent, ...legacy } = reader;
    expect(organizerSituation(legacy)).toEqual({ kind: "unknown" });
    // A build that sends no consent says nothing about nobody, whatever else the row carries.
    expect(organizerSituation({ ...legacy, organizerReleasedAt: T })).toEqual({ kind: "unknown" });
    // An unread lease still names a holder it remembers, as every banner does.
    expect(organizerSituation({ ...reader, organizerChecked: false, organizedBy: phone }))
      .toEqual({ kind: "organized_elsewhere", by: phone });
  });

  it("a pending Organize here is starting, and carries the state it waits on", () => {
    const pressed = organizerSituation({ ...reader, organizerReleasedAt: T, takeoverAuthorizedAt: T });
    expect(pressed).toEqual({ kind: "starting_here", standing: { kind: "nothing_organizes", why: "handed_back", lapsed: null } });
    expect(standingOf(pressed)).toEqual({ kind: "nothing_organizes", why: "handed_back", lapsed: null });
    expect(standingOf(organizerSituation({ ...reader, organizedBy: phone, organizerState: "held", takeoverAuthorizedAt: T })))
      .toEqual({ kind: "organized_elsewhere", by: phone });
  });
});

describe("gateKept — nobody screens first-time senders only where nothing organizes the mailbox", () => {
  const T = "2026-10-11T04:00:00.000Z";
  const handedBack = { status: "connected", organizerRole: "reader" as const, organizeConsentedAt: T, organizerReleasedAt: T };

  it("is false for each of the three reasons, and under a press still waiting on one", () => {
    expect(gateKept(handedBack)).toBe(false);
    expect(nothingOrganizesWhy(handedBack)).toBe("handed_back");
    expect(gateKept({ ...handedBack, organizeConsentedAt: null, organizerReleasedAt: null })).toBe(false);
    expect(gateKept({ ...handedBack, organizerReleasedAt: null })).toBe(false);
    expect(gateKept({ ...handedBack, takeoverAuthorizedAt: T })).toBe(false);
  });

  it("CONTROL: organizing here or elsewhere, stopping, parked or unread keep the claim it always had", () => {
    expect(gateKept({ ...handedBack, organizerRole: "organizer" })).toBe(true);
    expect(gateKept({ ...handedBack, organizedBy: { kind: "local", name: "Office" }, organizerState: "held" })).toBe(true);
    expect(gateKept({ ...handedBack, organizerParkedAt: T })).toBe(true);
    expect(gateKept({ ...handedBack, organizerChecked: false })).toBe(true);
    expect(nothingOrganizesWhy({ ...handedBack, organizerRole: "organizer" })).toBe(null);
  });

  it("notOrganizingYet is the never-agreed member and nothing wider", () => {
    expect(notOrganizingYet(handedBack)).toBe(false);
    expect(notOrganizingYet({ ...handedBack, organizeConsentedAt: null, organizerReleasedAt: null })).toBe(true);
  });
});
