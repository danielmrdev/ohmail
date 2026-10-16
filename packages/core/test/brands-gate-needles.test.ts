import { describe, it, expect } from "vitest";
import { BRANDS } from "../src/brands.js";
import { foldForMatch } from "../src/text-fold.js";
import { registrableDomain } from "../src/sender-check.js";
import { SHARED_PROVIDER_DOMAINS, isSharedProviderDomain } from "../src/rule-order.js";

/**
 * THE GATE'S NEEDLES OBEY THEIR LENGTH RULE, and the shared-provider list is read the brands' way.
 * A `gate` needle of five letters or more claims on word boundaries anywhere in a name; a shorter
 * one would claim "Ing." and "Meta Brunner", so it lives in `gateShort`, which claims only beside
 * a service word. The excluded common words are absent from every `gate` list.
 */
const letters = (s: string): number => (foldForMatch(s).match(/\p{L}/gu) ?? []).length;

/** Words a person or a shop wears as often as a brand does: advice only, never a gate needle. */
const EXCLUDED = ["sunrise", "orange", "apple", "switch", "stripe", "hermes", "finanzamt", "post"];

/** Domains a brand owns AND anyone can register an address at — pinned by name. */
const OVERLAP = ["a1.net", "bluewin.ch", "icloud.com", "orange.fr", "outlook.com", "sunrise.ch", "t-online.de"];

describe("the brand dictionary's gate needles", () => {
  it("refuses a gate needle under five letters and a short needle of five or more", () => {
    const bad: string[] = [];
    for (const b of BRANDS) {
      for (const n of b.gate ?? []) if (letters(n) < 5) bad.push(`${b.name} gate ${n}`);
      for (const n of b.gateShort ?? []) if (letters(n) >= 5) bad.push(`${b.name} gateShort ${n}`);
    }
    expect(bad).toEqual([]);
  });

  it("CONTROL: the rule reads letters, so it would refuse the planted shapes", () => {
    expect(letters("ubs")).toBeLessThan(5);
    expect(letters("ahv/iv")).toBe(5);
    expect(letters("1&1")).toBe(0);
    expect(letters("die post")).toBe(7);
  });

  it("keeps the excluded common words out of every gate list", () => {
    const gate = new Set(BRANDS.flatMap((b) => (b.gate ?? []).map(foldForMatch)));
    expect(EXCLUDED.filter((w) => gate.has(w))).toEqual([]);
    // …while the rows that carry them still exist for advice.
    expect(BRANDS.some((b) => b.name === "Sunrise" && b.gate === undefined)).toBe(true);
  });

  it("every gate needle is already one of its row's names, folded", () => {
    for (const b of BRANDS) {
      const names = new Set([b.name, ...b.aliases].map(foldForMatch));
      for (const n of [...(b.gate ?? []), ...(b.gateShort ?? [])]) {
        expect(names.has(foldForMatch(n)), `${b.name}: ${n}`).toBe(true);
      }
    }
  });
});

describe("the shared providers", () => {
  it("are exact registrable domains, lower case", () => {
    for (const d of SHARED_PROVIDER_DOMAINS) {
      expect(registrableDomain(d), d).toBe(d);
    }
    expect(isSharedProviderDomain("GMAIL.COM")).toBe(true);
    expect(isSharedProviderDomain("firma.example")).toBe(false);
  });

  it("overlap the brands' own domains in exactly the seven pinned by name", () => {
    const overlap = BRANDS.flatMap((b) => b.domains).filter(isSharedProviderDomain);
    expect([...new Set(overlap)].sort()).toEqual(OVERLAP);
  });
});
