/**
 * THE IDENTITY FACT ON THE PHONE (mail 0148, acceptance 16): the row says the sentence before every
 * other badge, the copy twins carry both forms in both languages, and the German is du-form. The
 * phone reads the fact off the wire and holds no dictionary of its own.
 */
import { describe, expect, it } from "vitest";
import type { Mail } from "../src/state/model";
import { rowBadgeFacts } from "../src/ui/row-spoken";
import { EN as en } from "../src/copy.en";
import { DE as de } from "../src/copy.de";

const ROW: Mail = {
  id: "m1", place: "ohbox", from: { name: "PostFinance", address: "kartenservice@freemail.example" },
  subject: "Bitte bestätigen", time: "09:12", body: "", unread: true, earlier: [],
} as unknown as Mail;

describe("the identity fact on the phone", () => {
  it("the row's first spoken fact is the sentence, for the shared-provider form", () => {
    const facts = rowBadgeFacts({ ...ROW, senderCheck: { brand: "PostFinance", domainShared: true, domain: "freemail.example" } });
    expect(facts[0]).toEqual({
      kind: "senderCheck", text: "This message claims to be from PostFinance, but anyone can register a freemail.example address.",
    });
  });

  it("says the address's own domain for an address at no shared provider", () => {
    const facts = rowBadgeFacts({ ...ROW, senderCheck: { brand: "PostFinance", domainShared: false, domain: "karten-service.example" } });
    expect(facts[0]).toEqual({
      kind: "senderCheck",
      text: "This message claims to be from PostFinance, but karten-service.example isn't one of PostFinance's addresses.",
    });
  });

  it("CONTROL: an unmarked row says no such fact", () => {
    expect(rowBadgeFacts(ROW).some((f) => f.kind === "senderCheck")).toBe(false);
  });

  it("the copy twins carry every sentence in both languages, the German addressing the reader as du", () => {
    expect(en.senderCheckChip("UBS")).toBe("Not UBS");
    expect(de.senderCheckChip("UBS")).toBe("Nicht UBS");
    const german = [
      de.senderCheckImpersonation("UBS", "ubs-sicherheit.example"), de.senderCheckImpersonationShared("UBS", "freemail.example"),
      de.screeningScopeShared("freemail.example"), de.rulesSharedProviderInert("freemail.example"),
    ];
    expect(german.filter((t) => /\b(Sie|Ihnen|Ihr|Ihre)\b/.test(t))).toEqual([]);
    expect(/\b(Sie|Ihnen|Ihr|Ihre)\b/.test("Entscheiden Sie pro Adresse.")).toBe(true);
  });
});
