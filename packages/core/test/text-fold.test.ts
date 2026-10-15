import { describe, it, expect } from "vitest";
import { CONFUSABLES, foldForMatch } from "../src/text-fold.js";

/**
 * THE MATCHER'S FOLD — one form for every name a sender wrote and a needle compares. Each case is
 * a disguise that renders as the word it imitates; the escapes keep the invisible characters
 * visible in this file.
 */
describe("foldForMatch", () => {
  it("folds homoglyphs, invisibles, soft hyphens, full-width forms and case onto one form", () => {
    expect(foldForMatch("Роstfinance")).toBe("postfinance");          // Cyrillic Р and о
    expect(foldForMatch("PostFınance")).toBe("postfinance");               // dotless ı
    expect(foldForMatch("Post​Finance")).toBe("postfinance");              // zero-width space
    expect(foldForMatch("Post­Finance")).toBe("postfinance");              // soft hyphen
    expect(foldForMatch("Ｐｏｓｔ")).toBe("post");              // full-width
    expect(foldForMatch("\u{1D40F}ost")).toBe("post");                          // mathematical bold P
  });

  it("strips a mark from the decomposition, so a precomposed letter folds to its base", () => {
    expect(foldForMatch("PöstFinance")).toBe("postfinance");
    expect(foldForMatch("Zürcher")).toBe("zurcher");
    expect(foldForMatch("Zürcher Kantonalbank")).toBe("zurcher kantonalbank");
  });

  it("collapses and trims whitespace and leaves ordinary text alone", () => {
    expect(foldForMatch("  Anna   Brunner \n")).toBe("anna brunner");
    expect(foldForMatch("1&1 Kundenservice")).toBe("1&1 kundenservice");
  });

  it("carries the dotless i in the shared table the sensitivity reader folds with too", () => {
    expect(CONFUSABLES["ı"]).toBe("i");
  });
});
