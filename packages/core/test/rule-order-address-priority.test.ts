import { describe, expect, it } from "vitest";
import { RULE_PRIORITY_MAX, addressPriorityOver } from "../src/rule-order.js";

/**
 * THE ONE LIFT, asked by the engine's rule write and by the decide: an address rule is written at
 * the lowest priority no rule on its domain filing elsewhere outranks, and never past the bound.
 */
describe("addressPriorityOver", () => {
  const five = { priority: 5, destination: "ohmail/Screened" };

  it("meets the highest domain rule filing elsewhere, and keeps a held value already above it", () => {
    expect(addressPriorityOver([five, { priority: 2, destination: "ohmail/News" }], "INBOX", 0)).toBe(5);
    expect(addressPriorityOver([five], "INBOX", 9)).toBe(9);
  });

  it("a domain rule filing to the same place is not a reason to lift", () => {
    expect(addressPriorityOver([{ priority: 7, destination: "INBOX" }], "INBOX", 0)).toBe(0);
    expect(addressPriorityOver([], "INBOX", 0)).toBe(0);
  });

  it("the bound is met; one past it declines", () => {
    expect(addressPriorityOver([{ ...five, priority: RULE_PRIORITY_MAX }], "INBOX", 0)).toBe(RULE_PRIORITY_MAX);
    expect(addressPriorityOver([{ ...five, priority: RULE_PRIORITY_MAX + 1 }], "INBOX", 0)).toBeNull();
  });

  it("a non-finite priority reads as 0, as the comparator reads it", () => {
    expect(addressPriorityOver([{ ...five, priority: Number.NaN }], "INBOX", 0)).toBe(0);
  });
});
