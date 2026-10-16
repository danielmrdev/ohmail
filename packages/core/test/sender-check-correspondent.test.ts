import { describe, expect, it } from "vitest";
import { CAP_CONFIDENCE, capSuggestion, senderCheck, senderFacts, type SenderSignals } from "../src/sender-check.js";

/**
 * A BOUGHT VERDICT CANNOT SAY SPAM OVER SOMEBODY THIS ACCOUNT WROTE TO — measured in the advice
 * layer, not asked of the prompt. The fact is the mailbox's (`correspondent.ts`), attached to the
 * signals by the caller; `capSuggestion` reads the SIGNAL, so the refusal holds whatever code the
 * check computed. A failed authentication outranks it: that is evidence the message is not theirs.
 */
const SPAM = { destination: "ohmail/Quarantine" as const, confidence: 1, rationale: "spam, clearly", spam: true };
const NEWS = { destination: "ohmail/News" as const, confidence: 0.8, rationale: "a newsletter", spam: false };
const base = (): SenderSignals => senderCheck({
  fromAddress: "them@corr.invalid", subject: "the north elevation", snippet: "Thursday works for me.",
});

describe("capSuggestion over a correspondent", () => {
  it("ACCEPTANCE: a 1.0 spam verdict becomes the Ohbox, its spam rationale dropped, with the reason", () => {
    const s = { ...base(), correspondent: { sentAt: "2026-09-22T15:12:00.000Z" } };
    expect(capSuggestion(SPAM, s)).toEqual({
      destination: "INBOX", confidence: CAP_CONFIDENCE, rationale: "", spam: false, reasonCode: "correspondent",
    });
  });

  it("an admitting answer stands, with the reason beside it", () => {
    const s = { ...base(), correspondent: { sentAt: "2026-09-22T15:12:00.000Z" } };
    expect(capSuggestion(NEWS, s)).toEqual({ ...NEWS, reasonCode: "correspondent" });
  });

  it("it outranks the facts about strangers — an impersonation-shaped mail from a correspondent", () => {
    const s = {
      ...senderCheck({ fromAddress: "them@corr.invalid", subject: "Swisscom: Rechnung überfällig", snippet: "" }),
      correspondent: { sentAt: "2026-09-22T15:12:00.000Z" },
    };
    expect(s.reasonCode).toBe("impersonation");
    expect(capSuggestion(SPAM, s).destination).toBe("INBOX");
  });

  it("CONTROL: a failed authentication outranks it — the message is not proven theirs", () => {
    const s = {
      ...senderCheck({ fromAddress: "them@corr.invalid", subject: "hello", snippet: "", authVerdict: "fail" }),
      correspondent: { sentAt: "2026-09-22T15:12:00.000Z" },
    };
    const capped = capSuggestion(NEWS, s);
    expect(capped.destination).toBe("ohmail/Quarantine");
    expect(capped.reasonCode).toBe("auth_fail");
  });

  it("CONTROL: a stranger's spam verdict is untouched", () => {
    expect(capSuggestion(SPAM, base())).toEqual(SPAM);
  });

  it("the model is told the fact, as a fact", () => {
    const facts = senderFacts({ ...base(), correspondent: { sentAt: "2026-09-22T15:12:00.000Z" } });
    expect(facts).toContain("this account wrote to this sender");
    expect(senderFacts(base())).toBeUndefined();
  });
});
