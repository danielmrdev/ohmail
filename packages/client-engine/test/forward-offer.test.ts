import { describe, expect, it } from "vitest";
import { forwardOffered, forwardPress } from "../src/index.js";

/**
 * FORWARD IS ALWAYS OFFERED (owner, 2026-09-25) — the one predicate every surface reads, and what
 * a press does first. The reported message was a tax document the OTP vocabulary flagged: it
 * showed only Reply. `ask` names the flag's reason; `fetch` is the mirror's answer, absent = held.
 */
const flags = (over: Partial<{ no_forward: boolean; category: "otp" | "verification" | "password_reset" | "security_alert" | null }> = {}) => ({
  sensitivity: {
    sensitive: over.no_forward === true, category: over.category ?? null, no_ai: false,
    no_forward: over.no_forward ?? false, no_kb: false, priority: false,
  },
});

describe("forwardOffered / forwardPress", () => {
  it("offers Forward on every message on screen — a no_forward one included", () => {
    expect(forwardOffered({ id: "m1" })).toBe(true);
    expect(forwardOffered(null)).toBe(false);
    expect(forwardOffered(undefined)).toBe(false);
  });

  it("a no_forward press asks once, naming the category the classifier gave", () => {
    expect(forwardPress(flags({ no_forward: true, category: "otp" })).ask).toBe("otp");
    expect(forwardPress(flags({ no_forward: true, category: "password_reset" })).ask).toBe("password_reset");
    // The flag without a category still asks, in the general sentence.
    expect(forwardPress(flags({ no_forward: true, category: null })).ask).toBe("sensitive");
  });

  it("an ordinary press asks nothing — the category alone never asks", () => {
    expect(forwardPress(flags()).ask).toBeNull();
    expect(forwardPress(flags({ no_forward: false, category: "otp" })).ask).toBeNull();
    expect(forwardPress({ sensitivity: undefined as never }).ask).toBeNull();
  });

  it("an off-mirror row fetches its body first; held or unstated does not", () => {
    expect(forwardPress(flags(), false).fetch).toBe(true);
    expect(forwardPress(flags(), true).fetch).toBe(false);
    expect(forwardPress(flags()).fetch).toBe(false);
  });
});
