import { describe, expect, it } from "vitest";
import { SENT_SHAPED_CANONICAL, SENT_SHAPED_PATHS, isSentFolderPath } from "../src/types.js";

/**
 * The SQL spelling of the Sent-shaped rule (`correspondent.ts` asks `lower(folder) in (…)`, the
 * device store having no regex) against the regex it spells. Every member matches, the language
 * has exactly the size its four prefixes and fourteen leaves give, and the regex's source is
 * pinned: an edit to the regex reddens here and is made to the list in the same change.
 */
describe("SENT_SHAPED_PATHS is SENT_SHAPED_CANONICAL's whole language", () => {
  it("every member is Sent-shaped, lower-cased, and distinct", () => {
    for (const p of SENT_SHAPED_PATHS) {
      expect(isSentFolderPath(p), p).toBe(true);
      expect(p).toBe(p.toLowerCase());
    }
    expect(new Set(SENT_SHAPED_PATHS).size).toBe(SENT_SHAPED_PATHS.length);
    expect(SENT_SHAPED_PATHS).toHaveLength(4 * 14);
  });

  it("the regex is the one this list was written from", () => {
    expect(SENT_SHAPED_CANONICAL.source).toBe(
      "^(inbox\\/|\\[(gmail|google mail)\\]\\/)?(sent([ -](items|messages|mail))?|gesendet(e[ -](objekte|elemente|nachrichten))?)$",
    );
    expect(SENT_SHAPED_CANONICAL.flags).toBe("i");
  });

  it("CONTROL: names beside the language are refused by both", () => {
    for (const p of ["archive", "inbox/archive", "sent/2019", "[gmail]/all mail", "gesendete", "sentitems"]) {
      expect(isSentFolderPath(p), p).toBe(false);
      expect(SENT_SHAPED_PATHS.includes(p), p).toBe(false);
    }
  });
});
