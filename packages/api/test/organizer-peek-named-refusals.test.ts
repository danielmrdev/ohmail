import { describe, expect, it } from "vitest";
import { LeaseUnavailableError } from "@trafficflow/core/adapters/organizer-lease";
import { organizerPeekRefusal } from "../src/organizer-peek.js";

/**
 * THE PEEK NAMES THE TWO REFUSALS A PERSON FIXES ON THE MAIL SERVER (PHONE-START-HERE-META-FOLDER-
 * FULL): `meta_folder_full` and `meta_undeletable` leave under their own codes, still 502 — a look
 * that did not land is never "nobody holds it" — and every other lease fault stays
 * `organizer_unreadable`.
 */
describe("the organizer peek's refusals", () => {
  it.each(["meta_folder_full", "meta_undeletable"] as const)("%s passes through under its own code", (op) => {
    const out = organizerPeekRefusal(new LeaseUnavailableError("refused", { op }));
    expect(out?.code, `${op} was answered as could-not-check`).toBe(op);
    expect(out?.httpStatus).toBe(502);
    expect(out?.message).toContain("ohmail/_meta");
  });

  it("CONTROL: an ordinary lease fault is still organizer_unreadable", () => {
    expect(organizerPeekRefusal(new LeaseUnavailableError("socket", { op: "list_claims" }))?.code).toBe("organizer_unreadable");
  });

  it("a fault that is not the lease's is not swallowed", () => {
    expect(organizerPeekRefusal(new Error("boom"))).toBeNull();
  });
});
