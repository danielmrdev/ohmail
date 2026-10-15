import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog, setActiveFormatZone } from "../app/shell/locale";
import { AGO_COPY, agoStamp } from "../app/shell/format";

/**
 * "SYNCED 2 MINUTES AGO", IN THE READER'S OWN LANGUAGE.
 *
 * `agoStamp` replaced a MailboxSection-local formatter that built its `Intl.RelativeTimeFormat`
 * with `undefined` — the BROWSER's locale, not the app's — and hardcoded English "just now" for
 * anything under 45 seconds. A German session read "Synchronisiert 1 minute ago": the sentence
 * frame came from the catalogue and the age inside it did not. What is pinned here:
 *
 *  1. the unit ladder (just-now → minutes → hours → days) and its boundaries;
 *  2. the young arm goes through the catalogue (`relativeTime.justNow`), never a literal;
 *  3. setting a German catalogue turns the WHOLE stamp German — the `Intl` part and the copy
 *     part — and unsetting it turns both back (the guard is the register, not a constant);
 *  4. an unparseable instant echoes back rather than rendering "Invalid Date".
 *
 * The zone is pinned to UTC where the ABSOLUTE half is asserted, so the expectation names an
 * instant rather than the CI machine's wall clock.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (l: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(HERE, "..", "messages", `${l}.json`), "utf8"));
const EN = read("en");
const GERMAN = fillFrom(EN as never, read("de") as never);

const NOW = Date.parse("2026-08-10T12:00:00.000Z");
/** An instant `secs` seconds before NOW, as the ISO string the DTOs carry. */
const before = (secs: number): string => new Date(NOW - secs * 1000).toISOString();

afterEach(() => {
  setActiveCatalog(DEFAULT_LOCALE, null);
  setActiveFormatZone(null);
});

describe("the unit ladder and its boundaries", () => {
  it("under 45 seconds is 'just now' — and it is the catalogue's sentence, not a literal", () => {
    expect(agoStamp(before(0), NOW).rel).toBe("just now");
    expect(agoStamp(before(44), NOW).rel).toBe("just now");
    // The same string the copy table answers, so a rewording lands in exactly one place.
    expect(agoStamp(before(44), NOW).rel).toBe(AGO_COPY.justNow);
  });

  it("45 seconds is the boundary: the first age old enough for a unit", () => {
    expect(agoStamp(before(45), NOW).rel).toBe("1 minute ago");
  });

  it("minutes up to an hour, hours up to a day, days beyond", () => {
    expect(agoStamp(before(120), NOW).rel).toBe("2 minutes ago");
    expect(agoStamp(before(3599), NOW).rel).toBe("60 minutes ago");
    expect(agoStamp(before(7200), NOW).rel).toBe("2 hours ago");
    expect(agoStamp(before(2 * 86400), NOW).rel).toBe("2 days ago");
  });

  it("a FUTURE instant clamps to 'just now' rather than saying 'in 3 minutes' about a sync stamp", () => {
    expect(agoStamp(before(-180), NOW).rel).toBe("just now");
  });

  it("an unparseable instant echoes back — in both halves, never 'Invalid Date'", () => {
    expect(agoStamp("not-a-date", NOW)).toEqual({ rel: "not-a-date", abs: "not-a-date" });
  });
});

describe("the stamp follows the APP's locale, not the platform's", () => {
  it("a German catalogue makes both arms German — the Intl unit and the young arm's copy", () => {
    setActiveCatalog("de", GERMAN as never);
    expect(agoStamp(before(120), NOW).rel).toBe("vor 2 Minuten");
    expect(agoStamp(before(7200), NOW).rel).toBe("vor 2 Stunden");
    expect(agoStamp(before(30), NOW).rel).toBe("gerade eben");
  });

  it("MUTATING the register is what turns the German off — the guard is not reading a constant", () => {
    setActiveCatalog("de", GERMAN as never);
    const german = agoStamp(before(30), NOW).rel;
    setActiveCatalog(DEFAULT_LOCALE, null);
    const english = agoStamp(before(30), NOW).rel;
    expect(german).toBe("gerade eben");
    expect(english).toBe("just now");
    expect(german).not.toBe(english);
  });

  it("the absolute half follows the same locale, in the injected zone", () => {
    setActiveFormatZone("UTC");
    const en = agoStamp(before(3600), NOW).abs;
    expect(en).toContain("Aug 10, 2026"); // medium date; the clock's AM-space varies by ICU
    expect(en).toContain("11:00");
    setActiveCatalog("de", GERMAN as never);
    const de = agoStamp(before(3600), NOW).abs;
    expect(de).toBe("10.08.2026, 11:00"); // German medium date, 24-hour clock
    expect(de).not.toBe(en);
  });
});
