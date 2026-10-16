import { describe, expect, it } from "vitest";
import { instantRefusal, readInstant } from "../src/instant.js";

/**
 * A DATE THE PERSON DID NOT WRITE IS REFUSED, NEVER NORMALISED. Measured on this host before
 * the fix: `Date.parse("2026-02-30T10:00:00Z")` answered March 2, `"2026-03-01T10:00:00"`
 * answered 09:00Z (Europe/Zurich), `"2026-03-01T24:00:00Z"` answered the next day — each a
 * moment nobody chose. The two refusals are named apart because the remedies differ: a day
 * that does not exist wants a different date, a time in no zone wants its offset.
 * THE MUTATION THAT MAKES THIS RED: in `readInstant`, `day > daysIn(year, month)` widened to
 * `day > 31` — every "no such day" arm admits February 30. Watched fail and restored.
 */
describe("readInstant — total, two refusals named apart", () => {
  it.each([
    ["2026-02-30T10:00:00Z", "February has no 30th"],
    ["2026-02-30T10:00:00.000Z", "…with milliseconds"],
    ["2027-02-29T10:00:00Z", "2027 is not a leap year"],
    ["2026-04-31T10:00:00Z", "April has no 31st"],
    ["2026-13-01T00:00:00Z", "month 13"],
    ["2026-00-10T00:00:00Z", "month 0"],
    ["2026-03-00T00:00:00Z", "day 0"],
    ["0999-03-01T00:00:00Z", "a year below 1000"],
    ["March 1 2026", "not the ISO shape"],
    ["notadate", "garbage"],
    ["2026-3-1T10:00:00Z", "unpadded fields"],
    ["", "empty"],
  ])("NOT A DATE: %s (%s)", (raw) => {
    expect(readInstant(raw)).toEqual({ ok: false, why: "not_a_date" });
  });

  it.each([
    ["2026-03-01T10:00:00", "a wall-clock time in no zone"],
    ["2026-03-01", "a day, not a moment"],
    ["2026-03-01T24:00:00Z", "24:00 is the next day's midnight, not a clock reading"],
    ["2026-03-01T10:60:00Z", "minute 60"],
    ["2026-03-01T10:00:60Z", "second 60"],
    ["2026-03-01T10:00:00+24:00", "an offset no zone has"],
    ["2026-03-01T10:00:00+02:60", "offset minutes 60"],
  ])("NOT A MOMENT: %s (%s)", (raw) => {
    expect(readInstant(raw)).toEqual({ ok: false, why: "not_a_moment" });
  });

  it.each([
    ["2026-08-28T18:00:00.000Z", "2026-08-28T18:00:00.000Z"],
    ["2026-08-28T18:00:00Z", "2026-08-28T18:00:00.000Z"],
    ["2026-08-28T18:00Z", "2026-08-28T18:00:00.000Z"],
    ["2026-08-28T18:00:00.123456Z", "2026-08-28T18:00:00.123Z"],
    ["2026-08-28T18:00:00+02:00", "2026-08-28T16:00:00.000Z"],
    ["2026-08-28T18:00:00-05:30", "2026-08-28T23:30:00.000Z"],
    ["2026-08-28T18:00:00+0200", "2026-08-28T16:00:00.000Z"],
    ["2024-02-29T00:00:00Z", "2024-02-29T00:00:00.000Z"],
    ["2000-02-29T00:00:00Z", "2000-02-29T00:00:00.000Z"],
    ["2026-12-31T23:59:59.999z", "2026-12-31T23:59:59.999Z"],
  ])("A MOMENT: %s reads as %s (the positive control)", (raw, iso) => {
    const read = readInstant(raw);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.at.toISOString()).toBe(iso);
  });

  it("agrees with Date.parse on every instant it admits — it is stricter, never different", () => {
    for (const raw of ["2026-08-28T18:00:00.000Z", "2026-08-28T18:00:00+02:00", "2026-01-01T00:00:00Z"]) {
      const read = readInstant(raw);
      expect(read.ok && read.at.getTime()).toBe(Date.parse(raw));
    }
  });

  it("names the field and the state in the refusal", () => {
    expect(instantRefusal("sendAt", "not_a_date")).toBe("sendAt is not a date");
    expect(instantRefusal("sendAt", "not_a_moment")).toMatch(/^sendAt is not a moment in time/);
  });
});
