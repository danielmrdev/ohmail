import { describe, expect, it } from "vitest";
import { ruleMatchKey as coreKey } from "@trafficflow/core/rule-order";
import { ruleMatchKey } from "../src/screener-apply.js";

/**
 * THE DRAIN'S COPY OF THE MATCH KEY IS CORE'S. This package cannot import core, so the key a rule's
 * `match` is compared by lives here twice; a tab or a non-breaking space kept by one and stripped
 * by the other names two senders for one rule.
 */
describe("the match key has one spelling", () => {
  it("the copy answers what core answers, padding and case included", () => {
    const inputs = ["  Alice@Example.COM  ", "\tbob@example.com", "carol@example.com\t", "\u00a0dan@x.test",
      "", "   ", "eve@example.com", " a b ", "Mixed.Domain.Test ",
      "\nfrank@example.com", "grace@example.com\n", " \t\n heidi@example.com \n\t "];
    for (const m of inputs) expect(ruleMatchKey(m), JSON.stringify(m)).toBe(coreKey(m));
  });
});
