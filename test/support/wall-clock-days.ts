/**
 * ONE FIXTURE FOR EVERY WALL-CLOCK APPOINTMENT THIS PRODUCT BOOKS — the two nights a year a
 * chosen clock cannot simply be written onto a day, and the ordinary ones beside them.
 *
 * It lives at the repo root because the webapp and the phone have to answer these identically and
 * a table copied into each app is two tables that agree until somebody edits one. Every row is the
 * answer `composeZonedWallClock` gives; a surface that composes its own arithmetic fails against
 * the row rather than against a sibling test nobody runs in the same pass.
 */

/** Zurich: 2027-03-28 skips 02:00-03:00, 2026-10-25 repeats 02:00-03:00. */
export const WALL_CLOCK_ZONE = "Europe/Zurich";

export interface WallClockCase {
  /** What it is, for the failure message. */
  name: string;
  /** The calendar day asked for, where the reader is — "YYYY-MM-DD". */
  day: string;
  /** The wall clock asked for on it. */
  hour: number;
  minute: number;
  /** The instant booked, as the UTC ISO string every appointment is stored as. */
  iso: string;
  /** The clock that instant READS as in the zone — "HH:MM", equal to the ask only when exact. */
  time: string;
  verdict: "exact" | "shifted_forward" | "first_of_two";
}

export const WALL_CLOCK_CASES: readonly WallClockCase[] = [
  {
    name: "the skipped half hour",
    day: "2027-03-28", hour: 2, minute: 30,
    iso: "2027-03-28T01:30:00.000Z", time: "03:30", verdict: "shifted_forward",
  },
  {
    name: "the skipped whole hour — a send-later hour's shape",
    day: "2027-03-28", hour: 2, minute: 0,
    iso: "2027-03-28T01:00:00.000Z", time: "03:00", verdict: "shifted_forward",
  },
  {
    name: "the half hour that happens twice",
    day: "2026-10-25", hour: 2, minute: 30,
    iso: "2026-10-25T00:30:00.000Z", time: "02:30", verdict: "first_of_two",
  },
  {
    name: "the whole hour that happens twice",
    day: "2026-10-25", hour: 2, minute: 0,
    iso: "2026-10-25T00:00:00.000Z", time: "02:00", verdict: "first_of_two",
  },
  {
    name: "the morning after the change — the positive control on the same clock",
    day: "2027-03-29", hour: 2, minute: 30,
    iso: "2027-03-29T00:30:00.000Z", time: "02:30", verdict: "exact",
  },
  {
    name: "an ordinary evening — send later's own preset hour",
    day: "2026-08-12", hour: 18, minute: 0,
    iso: "2026-08-12T16:00:00.000Z", time: "18:00", verdict: "exact",
  },
  {
    name: "the product's 09:00 on the skipped morning — the hour that survives it",
    day: "2027-03-28", hour: 9, minute: 0,
    iso: "2027-03-28T07:00:00.000Z", time: "09:00", verdict: "exact",
  },
];

/** `'HH:MM'` — what a stored resurface time and a `datetime-local` value both spell. */
export function askedTime(c: WallClockCase): string {
  return `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
}

/** Whole days from `from`'s calendar day in the zone to the case's — the phone's own input. */
export function daysAhead(from: Date, c: WallClockCase): number {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: WALL_CLOCK_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(from);
  return Math.round((Date.parse(`${c.day}${"T"}00:00:00Z`) - Date.parse(`${f}${"T"}00:00:00Z`)) / 86_400_000);
}
