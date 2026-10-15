import { describe, expect, it } from "vitest";
import { evaluateRules, type Rule } from "../src/rules.js";
import type { NormalizedMessage } from "../src/types.js";
import { placingRule, ruleClaims, type ClaimingRule } from "../src/rule-order.js";

/**
 * THE ONE CLAIM (`ruleClaims` / `placingRule`, `rule-order.ts`) — what the router files by and what
 * every client places by. `unknown` exists for a client that does not hold the text or the headers;
 * the router always holds both, so an `unknown` reaching `evaluateRules` is refused by name rather
 * than filed on a guess.
 */

const r = (o: Partial<ClaimingRule> & Pick<ClaimingRule, "id">): ClaimingRule => ({
  kind: "sender", match: "a@x.test", destination: "INBOX", priority: 0, effect: "allow", provenance: "manual", enabled: true,
  subjectContains: null, bodyContains: null, ...o,
});
const at = { author: "a@x.test", subject: "Weekly alert", text: "to unsubscribe press here", headers: {} };

describe("ruleClaims", () => {
  it("claims, declines, and answers unknown only for what the caller does not hold", () => {
    expect(ruleClaims(r({ id: "1" }), at)).toBe("claims");
    expect(ruleClaims(r({ id: "2", subjectContains: "alert" }), at)).toBe("claims");
    expect(ruleClaims(r({ id: "3", subjectContains: "invoice" }), at)).toBe("declines");
    expect(ruleClaims(r({ id: "4", bodyContains: "unsubscribe" }), { ...at, text: null })).toBe("unknown");
    // A subject that declines is a decline whatever the text: no text is needed to say so.
    expect(ruleClaims(r({ id: "5", subjectContains: "invoice", bodyContains: "x" }), { ...at, text: null })).toBe("declines");
    expect(ruleClaims(r({ id: "6", kind: "header", match: "list-id" }), { ...at, headers: null })).toBe("unknown");
    expect(ruleClaims(r({ id: "7", match: "b@x.test" }), at)).toBe("declines");
  });

  it("placingRule names the undecided body rule only where it would outrank the winner", () => {
    const bare = r({ id: "bare" });
    const body = r({ id: "body", effect: "deny", bodyContains: "unsubscribe" });
    expect(placingRule([bare, body], { ...at, text: null })).toEqual({ rule: bare, undecided: body });
    expect(placingRule([bare, body], at)).toEqual({ rule: body, undecided: null });
    const outranking = r({ id: "bare-5", priority: 5 });
    expect(placingRule([outranking, body], { ...at, text: null })).toEqual({ rule: outranking, undecided: null });
  });
});

describe("the router refuses an unknown claim by name", () => {
  it("a message handed to it without its text is refused, never filed on a guess", () => {
    const rules: Rule[] = [{
      id: "b", kind: "sender", match: "a@x.test", destination: "ohmail/Screened", effect: "deny",
      priority: 0, provenance: "manual", enabled: true, subjectContains: null, bodyContains: "unsubscribe",
    }];
    const msg = {
      canonical: { messageIdHeader: null, bodyHash: "h" }, subject: "Hi", from: { name: null, address: "a@x.test" },
      to: [], cc: [], date: null, headers: { from: ["a@x.test"] }, textBody: null, htmlBody: null,
      hasAttachments: false, attachments: [],
    } as unknown as NormalizedMessage;
    expect(() => evaluateRules({
      msg, rules, ownAddresses: new Set(), knownSenders: { addresses: new Set(), inferred: new Set<string>(), lists: new Map() }, auth: "unauthenticated", ohboxPolicy: "people_and_replied", identity: null,
    })).toThrow(/could not be judged/);
  });
});
