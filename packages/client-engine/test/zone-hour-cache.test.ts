import { describe, expect, it, vi } from "vitest";
import { formattedFields, zonedDayNumber, zonedFields } from "../src/zone.js";

/**
 * THE HOUR CACHE ANSWERS WHAT THE PLATFORM ANSWERS. `zonedFields` reads a zone's offset once per UTC
 * hour and computes the rest; every minute of every 2026 transition day, in zones whose transitions
 * fall on the hour, on the half hour (Lord Howe moves by 30 minutes) and at :45 (Chatham), must read
 * exactly as `formatToParts` reads it, and a zone with no transition (Kolkata, UTC) too.
 */

const ZONES = ["Europe/Zurich", "America/New_York", "Australia/Lord_Howe", "Pacific/Chatham", "Asia/Kolkata", "UTC"];
const DAY = 86_400_000;
const MIN = 60_000;

function offsetOf(ms: number, zone: string): number {
  const f = formattedFields(new Date(ms), zone);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - Math.floor(ms / 1000) * 1000;
}

/** The UTC days of 2026 on which `zone`'s offset changes (plus the first of the year as a control). */
function transitionDays(zone: string): number[] {
  const start = Date.UTC(2026, 0, 1);
  const days = [start];
  for (let d = start; d < Date.UTC(2027, 0, 1); d += DAY) {
    if (offsetOf(d, zone) !== offsetOf(d + DAY, zone)) days.push(d);
  }
  return days;
}

describe("zonedFields' hour cache", () => {
  for (const zone of ZONES) {
    it(`${zone}: every minute of its 2026 transition days reads as formatToParts does`, () => {
      const days = transitionDays(zone);
      if (zone === "Asia/Kolkata" || zone === "UTC") expect(days).toHaveLength(1);
      else expect(days.length).toBeGreaterThanOrEqual(3);
      let checked = 0;
      for (const d of days) {
        for (let t = d - DAY; t < d + 2 * DAY; t += MIN) {
          // An odd second inside the minute, so the arithmetic is asked about seconds too.
          const at = new Date(t + 17_250);
          expect(zonedFields(at, zone), `${zone} @ ${at.toISOString()}`).toEqual(formattedFields(at, zone));
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(4000);
    });
  }

  it("asks formatToParts at most twice per hour bucket on a warm run", () => {
    const zone = "Europe/Zurich";
    const base = Date.UTC(2026, 5, 10, 8, 0, 0);
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    try {
      for (let i = 0; i < 10_000; i++) zonedDayNumber(new Date(base + (i % 3600) * 1000), zone);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
      spy.mockClear();
      for (let i = 0; i < 10_000; i++) zonedDayNumber(new Date(base + (i % 3600) * 1000), zone);
      expect(spy.mock.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("an unknown zone and an invalid instant still throw", () => {
    expect(() => zonedFields(new Date(), "Not/A_Zone")).toThrow(RangeError);
    expect(() => zonedFields(new Date(Number.NaN), "Europe/Zurich")).toThrow(RangeError);
  });
});
