/**
 * THE PHONE'S TIME LABELS, AFTER THEY STOPPED MINTING THEIR OWN CLOCK.
 *
 * Every instant the phone names in a sentence — a set time (a resurface, a send-later, the away end
 * date) and a past one (the stale mirror's "as of", an outage's "since") — reads `setTimeLabel`,
 * the engine's `appointmentStamp`: the clock alone today, the weekday inside the week, the date
 * past it. The past labels printed a weekday alone for any age, so a mirror closed eleven days ago
 * read "As of Mon 09:00", this week's Monday by every other stamp.
 */
import { describe, expect, it } from "vitest";
import { appointmentStamp } from "@ohmail/client-engine";
import { connectionSay, scheduleLabel, setTimeLabel, staleAsOf } from "../src/state/live";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const ZURICH = "Europe/Zurich";

describe("the stale 'as of' and the outage 'since' — past instants by the same stamp", () => {
  const FRIDAY = new Date("2026-09-25T15:35:00.000Z");
  const stale = (asOf: string | null) => ({
    freshness: () => ({ state: "stale" as const, asOf }),
  });

  it("names the date past the week, and the clock alone today", () => {
    expect(staleAsOf(stale("2026-09-14T07:00:00.000Z"), ZURICH, FRIDAY)).toBe("14 Sep, 09:00");
    expect(staleAsOf(stale("2026-09-18T07:00:00.000Z"), ZURICH, FRIDAY)).toBe("18 Sep, 09:00");
    expect(staleAsOf(stale("2026-09-19T07:00:00.000Z"), ZURICH, FRIDAY)).toBe("Sat 09:00");
    expect(staleAsOf(stale("2026-09-25T07:00:00.000Z"), ZURICH, FRIDAY)).toBe("09:00");
  });

  it("an outage past a week says since which date", () => {
    const here = { reachable: false, unreachableSince: "2026-09-14T07:00:00.000Z", signInRefused: false };
    expect(connectionSay(here, FRIDAY, ZURICH)).toEqual({ kind: "gone", since: "14 Sep, 09:00" });
  });

  it("is the engine's appointment stamp, band for band", () => {
    for (const iso of [
      "2026-09-25T06:00:00.000Z", "2026-09-22T06:00:00.000Z", "2026-09-10T06:00:00.000Z",
      "2025-09-10T06:00:00.000Z",
    ]) {
      expect(staleAsOf(stale(iso), ZURICH, FRIDAY)).toBe(appointmentStamp(new Date(iso), FRIDAY, ZURICH));
    }
  });

  it("reads the instant in the zone it is given — both the day and the hour", () => {
    // 23:30 UTC on a Wednesday is already Thursday in Zurich. A label that moved only the hour
    // would say "Wed 01:30" and name the wrong day at the wrong time.
    expect(staleAsOf(stale("2026-09-23T23:30:00.000Z"), "UTC", FRIDAY)).toBe("Wed 23:30");
    expect(staleAsOf(stale("2026-09-23T23:30:00.000Z"), ZURICH, FRIDAY)).toBe("Thu 01:30");
  });

  it("MIDNIGHT IS 00, never 24", () => {
    expect(staleAsOf(stale("2026-09-23T00:07:00.000Z"), "UTC", FRIDAY)).toBe("Wed 00:07");
  });

  it("no label while current or without a stamp, and an unknown zone echoes the instant", () => {
    expect(staleAsOf({ freshness: () => ({ state: "current" as const, asOf: "2026-09-14T07:00:00.000Z" }) }, ZURICH, FRIDAY))
      .toBeNull();
    expect(staleAsOf(stale(null), ZURICH, FRIDAY)).toBeNull();
    expect(staleAsOf(stale("2026-09-14T07:00:00.000Z"), "Not/AZone", FRIDAY)).toBe("2026-09-14T07:00:00.000Z");
  });
});

describe("scheduleLabel — inside the week the weekday, beyond it the date", () => {
  it("uses the weekday form while the appointment is less than six days out", () => {
    expect(scheduleLabel("2026-08-14T18:00:00.000Z", NOW, "UTC")).toBe("Fri 18:00");
  });

  it("switches to day, short month and clock once a weekday would be ambiguous", () => {
    // Past a week "Fri" no longer says WHICH Friday, and an appointment is exactly the value that
    // ambiguity misleads about.
    expect(scheduleLabel("2026-09-12T18:00:00.000Z", NOW, "UTC")).toBe("12 Sep, 18:00");
    expect(scheduleLabel("2026-09-20T07:05:00.000Z", NOW, "UTC")).toBe("20 Sep, 07:05");
  });

  it("reads both bands in the given zone", () => {
    expect(scheduleLabel("2026-09-12T23:30:00.000Z", NOW, ZURICH)).toBe("13 Sep, 01:30");
  });

  it("midnight is 00 in the far band too", () => {
    expect(scheduleLabel("2026-09-12T00:07:00.000Z", NOW, "UTC")).toBe("12 Sep, 00:07");
  });

  it("echoes what it cannot parse", () => {
    expect(scheduleLabel("next tuesday", NOW, "UTC")).toBe("next tuesday");
  });
});

/* A SET TIME ON THE PHONE: the resurface toast, the Resurface pile's row and the
   away end date read `setTimeLabel`, which is the engine's `appointmentStamp` — the function the
   webapp's `resurfaceLabel` reads — so the phone and the web name a set time alike. */
describe("setTimeLabel — a set time names its date past this week", () => {
  const FRIDAY = new Date("2026-09-25T15:35:00.000Z");

  it("25 Dec from a Friday afternoon reads as 25 Dec, not as this morning", () => {
    expect(setTimeLabel("2026-12-25T09:00:00.000Z", FRIDAY, ZURICH)).toBe("25 Dec, 10:00");
  });

  it("is the engine's appointment stamp, band for band", () => {
    for (const iso of [
      "2026-09-25T18:00:00.000Z", "2026-09-28T07:00:00.000Z", "2026-10-02T07:00:00.000Z",
      "2026-12-25T09:00:00.000Z", "2027-01-08T08:00:00.000Z", "2026-09-10T08:00:00.000Z",
    ]) {
      expect(setTimeLabel(iso, FRIDAY, ZURICH)).toBe(appointmentStamp(new Date(iso), FRIDAY, ZURICH));
    }
    expect(setTimeLabel("2026-09-25T16:00:00.000Z", FRIDAY, ZURICH)).toBe("18:00");
  });

  it("echoes what it cannot parse, and an unknown zone", () => {
    expect(setTimeLabel("tomorrow", FRIDAY, "UTC")).toBe("tomorrow");
    expect(setTimeLabel("2026-12-25T09:00:00.000Z", FRIDAY, "Not/AZone")).toBe("2026-12-25T09:00:00.000Z");
  });
});
