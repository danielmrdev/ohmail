import { describe, expect, it } from "vitest";
import {
  BACKLOG_PAGE_LIMIT, drainPageLimit, mirrorFreshness, mirrorStale, STALE_RESUME_MS,
} from "../src/drain-policy.js";

/**
 * THE DRAIN POLICY — the four decisions every client mirror makes about its own age, pinned once
 * for the two drivers that make them (INSTANT-ARCH §6.7, stage 7's first adopted responsibility).
 *
 * Until this module existed the same four decisions were written twice: `STALE_RESUME_MS` /
 * `CLOUD_STALE_RESUME_MS`, `BACKLOG_PAGE_LIMIT` / `STALE_REPLAY_PAGE_LIMIT`, and two hand-written
 * copies each of the stale predicate and the three-state derivation. The values agreed on the day
 * they were written, which is exactly what makes a duplication like this dangerous rather than
 * obviously broken: nothing was red, and the next change to the policy would have landed on one
 * surface and missed the other.
 *
 * These cases are about the EDGES, because the middle was never the risk. The two functions
 * deliberately DISAGREE about a missing stamp, and the whole reason both exist is that the
 * disagreement is correct — a resume must assume the worst, a label must never invent a time.
 */

const AT = (iso: string): Date => new Date(iso);
const t0 = "2026-08-30T12:00:00.000Z";

describe("mirrorStale — the resume verdict", () => {
  it("is false while the stamp is inside the threshold and true one millisecond past it", () => {
    // The boundary is `>`, not `>=`: a mirror stamped EXACTLY one threshold ago is still current.
    const edge = AT("2026-08-30T12:05:00.000Z"); // t0 + STALE_RESUME_MS
    expect(STALE_RESUME_MS).toBe(5 * 60_000);
    expect(mirrorStale(t0, edge)).toBe(false);
    expect(mirrorStale(t0, new Date(edge.getTime() + 1))).toBe(true);
  });

  it("treats BOTH spellings of an absent stamp as stale", () => {
    // The engine's mirror meta answers `undefined`; the sidecar's cursor file answers `null`.
    // Normalising one into the other at a call site is how a second implementation grows back.
    expect(mirrorStale(undefined, AT(t0))).toBe(true);
    expect(mirrorStale(null, AT(t0))).toBe(true);
  });

  it("treats an unparseable stamp as stale — the driver's own corrupt write is answered by freshening", () => {
    expect(mirrorStale("not a date", AT(t0))).toBe(true);
  });

  it("honours a caller-supplied threshold (the test seam both drivers expose)", () => {
    const later = AT("2026-08-30T12:00:10.000Z");
    expect(mirrorStale(t0, later, 5_000)).toBe(true);
    expect(mirrorStale(t0, later, 60_000)).toBe(false);
  });

  it("reads a stamp in the FUTURE as stale: the clock stepped back, so how long ago is unknown", () => {
    // Freshens once, not every drain: each driver re-stamps at completion on the clock it now reads
    // (the client engine's case in stale-resume-freshness.test.ts drives the second drain).
    expect(mirrorStale("2026-08-30T13:00:00.000Z", AT(t0))).toBe(true);
    expect(mirrorStale("2026-08-30T12:00:00.001Z", AT(t0))).toBe(true);
    expect(mirrorStale(t0, AT(t0)), "CONTROL: a stamp at now is current").toBe(false);
  });
});

describe("mirrorFreshness — the label", () => {
  it("says `unknown` with NO time for both spellings of an absent stamp", () => {
    // The asymmetry with `mirrorStale` is the point: there is no time to put in "as of …", and a
    // surface that invented one would be lying about a fact it does not have.
    expect(mirrorFreshness(undefined, AT(t0))).toEqual({ state: "unknown", asOf: null });
    expect(mirrorFreshness(null, AT(t0))).toEqual({ state: "unknown", asOf: null });
  });

  it("says `unknown` for an unparseable stamp rather than a label with no time in it", () => {
    expect(mirrorFreshness("not a date", AT(t0))).toEqual({ state: "unknown", asOf: null });
  });

  it("crosses from `current` to `stale` at the same instant the resume verdict flips", () => {
    const edge = AT("2026-08-30T12:05:00.000Z");
    expect(mirrorFreshness(t0, edge)).toEqual({ state: "current", asOf: t0 });
    expect(mirrorFreshness(t0, new Date(edge.getTime() + 1))).toEqual({ state: "stale", asOf: t0 });
  });

  it("labels a stamp in the FUTURE as stale, the verdict `mirrorStale` gives it", () => {
    expect(mirrorFreshness("2026-08-30T13:00:00.000Z", AT(t0)), "a future stamp read as current")
      .toEqual({ state: "stale", asOf: "2026-08-30T13:00:00.000Z" });
    expect(mirrorFreshness(t0, AT(t0)), "CONTROL: a stamp at now is current").toEqual({ state: "current", asOf: t0 });
  });

  it("returns the stamp VERBATIM — surfaces format it, they never re-derive it", () => {
    const odd = "2026-08-30T12:00:00+02:00";
    expect(mirrorFreshness(odd, AT(t0)).asOf).toBe(odd);
  });
});

describe("the two derivations agree wherever they are allowed to", () => {
  /**
   * ONE VERDICT OBSERVED TWICE. A freshen without the label leaves staleness silent; a label
   * without the freshen leaves the newest mail at the end of the replay. So for every PRESENT,
   * PARSEABLE stamp the two functions must agree exactly — and the only inputs where they may
   * differ are the two the tests above pin individually.
   */
  it("stale ⇔ `stale`, for every parseable stamp across the threshold", () => {
    const now = AT(t0);
    for (const offsetMs of [0, 1, 1_000, STALE_RESUME_MS - 1, STALE_RESUME_MS, STALE_RESUME_MS + 1, 60 * 60_000]) {
      const stamp = new Date(now.getTime() - offsetMs).toISOString();
      expect({ offsetMs, stale: mirrorStale(stamp, now) })
        .toEqual({ offsetMs, stale: mirrorFreshness(stamp, now).state === "stale" });
    }
  });

  it("differs on an absent or corrupt stamp, and ONLY there", () => {
    const now = AT(t0);
    for (const stamp of [undefined, null, "not a date"] as const) {
      expect(mirrorStale(stamp, now)).toBe(true);
      expect(mirrorFreshness(stamp, now).state).toBe("unknown");
    }
  });
});

describe("drainPageLimit — the dense-page ask", () => {
  it("asks for the backlog limit on a stale resume and the driver's own default otherwise", () => {
    expect(drainPageLimit(true, 500)).toBe(BACKLOG_PAGE_LIMIT);
    expect(drainPageLimit(false, 500)).toBe(500);
  });

  it("carries `undefined` through — the engine's steady-state ask sends no `limit=` at all", () => {
    expect(drainPageLimit(false, undefined)).toBeUndefined();
    expect(drainPageLimit(true, undefined)).toBe(BACKLOG_PAGE_LIMIT);
  });

  it("is the server's own MAX_LIMIT — asking for more would be clamped there anyway", () => {
    expect(BACKLOG_PAGE_LIMIT).toBe(2000);
  });
});
