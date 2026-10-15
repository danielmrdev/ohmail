import { describe, expect, it } from "vitest";
import { OrganizedElsewhereError } from "../src/organizer-role.js";

/**
 * THE REFUSAL'S OWN SENTENCE SAYS WHAT IS TRUE FOR ITS REASON. It said "another install is
 * organizing this mailbox" for a mailbox nothing organizes, which is the one state a reader's
 * press most often meets (handed back, or setup not finished).
 */

const nobody = { kind: null, name: null, since: null };
const laptop = { kind: "local" as const, name: "Studio laptop", since: "2026-09-01T09:00:00.000Z" };

describe("OrganizedElsewhereError's message follows the reason", () => {
  it("no_organizer: nothing organizes it, and no holder is claimed", () => {
    const e = new OrganizedElsewhereError("mb", nobody, "no_organizer");
    expect(e.message).toMatch(/^nothing organizes this mailbox right now/);
    expect(e.message).not.toContain("another install");
    expect(e.details).toEqual({ by: nobody, reason: "no_organizer" });
  });

  it("organizer_outdated: an older install organizes it", () => {
    const e = new OrganizedElsewhereError("mb", laptop, "organizer_outdated");
    expect(e.message).toMatch(/^the install that organizes this mailbox runs a version that cannot take/);
  });

  it("no reason, a named holder: another install organizes it (the sentence every door had)", () => {
    expect(new OrganizedElsewhereError("mb", laptop).message)
      .toMatch(/^another install is organizing this mailbox, so this install is a reader/);
  });

  it("no reason, no holder named: a reader, with no holder claimed", () => {
    const m = new OrganizedElsewhereError("mb", nobody).message;
    expect(m).toMatch(/^on this mailbox this install is a reader/);
    expect(m).not.toContain("another install");
  });

  it("the code, status and details are unchanged", () => {
    const e = new OrganizedElsewhereError("mb", laptop, "organizer_outdated");
    expect([e.code, e.httpStatus, e.name]).toEqual(["organized_elsewhere", 409, "OrganizedElsewhereError"]);
    expect(e.details).toEqual({ by: laptop, reason: "organizer_outdated" });
  });
});
