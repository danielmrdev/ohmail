import { describe, expect, it } from "vitest";
import { localeFromCookieHeader } from "../app/shell/locale";

/**
 * The locale cookie is client-writable and read in the server render of every
 * product page, so a value `decodeURIComponent` refuses must read as no cookie rather than throw.
 */
describe("the locale cookie read", () => {
  it("a malformed locale cookie reads as no locale, never a throw", () => {
    let got: unknown = "threw";
    try { got = localeFromCookieHeader("ohmail.locale=%"); } catch { got = "threw"; }
    expect(got).toBeNull();
  });
  it("control: a well-formed cookie still reads", () => {
    expect(localeFromCookieHeader("ohmail.locale=de")).toBe("de");
  });
});
