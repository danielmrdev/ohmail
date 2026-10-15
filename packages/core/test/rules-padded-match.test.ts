import { describe, it, expect } from "vitest";
import { effectForDestination, evaluateRules, type Rule } from "../src/rules.js";
import { ruleMatchKey } from "../src/rule-order.js";
import type { NormalizedMessage } from "../src/types.js";

/**
 * A PADDED RULE NAMES ITS SENDER AT THE GATE TOO. `rules.match` has no trim constraint and the
 * queue's SQL compares `trim(lower(match))`, so a rule stored as " anna@x.test " was decided in
 * the queue and ignored by the arrival gate — the sender read undecided on the Ohbox screen. This
 * is a routing change, so both sides are pinned: a padded rule now fires, an unpadded one still
 * does, and a rule for somebody else still does not.
 */

function msg(from: string): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "x" },
    subject: "s", from: { name: null, address: from }, to: [], cc: [],
    date: null, headers: {}, textBody: "", htmlBody: null, hasAttachments: false, attachments: [],
  };
}

const rule = (over: Pick<Rule, "match"> & Partial<Pick<Rule, "kind" | "destination">>): Rule => {
  const destination = over.destination ?? "INBOX";
  return {
    id: "r", kind: over.kind ?? "sender", match: over.match, destination,
    effect: effectForDestination(destination), priority: 0, provenance: "manual", enabled: true,
    subjectContains: null, bodyContains: null,
  };
};

const decide = (from: string, rules: Rule[]) => evaluateRules({
  msg: msg(from), rules, ownAddresses: new Set<string>(), knownSenders: { addresses: new Set<string>(), inferred: new Set<string>(), lists: new Map() },
  auth: "unauthenticated", ohboxPolicy: "people_and_replied", identity: null,
});

describe("the gate compares a rule's match the way the queue's SQL does", () => {
  it("a sender rule padded with spaces fires", () => {
    expect(decide("anna@x.test", [rule({ match: "  Anna@X.test " })]))
      .toEqual({ destination: "INBOX", matchedRuleId: "r", source: "rule" });
  });

  it("a domain rule padded with spaces fires", () => {
    expect(decide("anna@x.test", [rule({ kind: "domain", match: " x.test  ", destination: "ohmail/News" })]))
      .toEqual({ destination: "ohmail/News", matchedRuleId: "r", source: "rule" });
  });

  it("a padded DENY rule screens its sender out rather than asking again", () => {
    expect(decide("anna@x.test", [rule({ match: " anna@x.test", destination: "ohmail/Screened" })]))
      .toEqual({ destination: "ohmail/Screened", matchedRuleId: "r", source: "rule" });
  });

  it("CONTROL — an unpadded rule still fires, and a padded rule for somebody else does not", () => {
    expect(decide("anna@x.test", [rule({ match: "anna@x.test" })]).source).toBe("rule");
    expect(decide("anna@x.test", [rule({ match: " bob@x.test " })]).source).toBe("screener");
  });

  it("the key strips spaces only — the SQL's `trim` — and lower-cases", () => {
    expect(ruleMatchKey("  A@B.test ")).toBe("a@b.test");
    expect(ruleMatchKey("\ta@b.test")).toBe("\ta@b.test");
    expect(ruleMatchKey("   ")).toBe("");
  });
});
