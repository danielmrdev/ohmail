import { describe, expect, it } from "vitest";

import {
  CLAIM_PROTOCOL,
  DEFAULT_STALE_AFTER_MS,
  MAX_FUTURE_SKEW_MS,
  answerLeasePeek,
  decideLease,
  formatClaim,
  holderKind,
  parseClaim,
  peekLease,
  type ClaimInput,
  type ClaimRecord,
  type LeaseSelf,
  type LeaseVerdict,
  type OrganizerClaim,
} from "@trafficflow/core/adapters/organizer-lease";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A LONE CLAIM IS NOT ITS OWN CLOCK
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `decideLease`'s rules 1 and 2 refuse a press — any press, including an authorized one — while a
 * claim this build cannot RANK is live: a higher protocol, or a kind that is not in this release's
 * closed set. That refusal is right, and the rulings bound it: the project's design notes §4 and
 * `PHONE-SQLITE-RULING.md` §1.4 both say the refusal stands *until the claim is stale or
 * released*.
 *
 * Liveness for that scan was FOLDER-RELATIVE — `newest heartbeat in the folder − this heartbeat <
 * staleAfterMs` — and folder-relative liveness has one degenerate case: the claim that IS the
 * folder's newest heartbeat is measured against itself, the difference is zero, and it reads live
 * at ANY age. A folder holding exactly one claim is the ordinary shape of that. So the "until" had
 * no content: an install that stopped organizing a year ago and left its record behind, or a phone
 * whose `mobile` kind an older desktop reads as `unknown`, refused every press for ever.
 *
 * The rows below are the decision table for that boundary, and they come in pairs on purpose:
 * every row that admits a press has a sibling row asserting that a LIVE unrankable claim still
 * refuses one. Weakening rule 1/2 is the two-organizer bug, and a table that only tested the
 * admissions could not tell the fix from the bug.
 */

const NOW = new Date("2026-09-07T09:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
/** Comfortably past one window, so "stale" is not an off-by-one about the boundary. */
const STALE = DEFAULT_STALE_AFTER_MS + 60_000;

function claim(over: Partial<OrganizerClaim> = {}): OrganizerClaim {
  return {
    installId: "them",
    kind: "local",
    protocol: CLAIM_PROTOCOL,
    heartbeat: ago(1_000),
    /* No server stamp, which is what a hand-built claim honestly is: `withServerClock` leaves such
       a record exactly as it is, so every row below still measures the writer-stamp rules it was
       written to measure. A row that wants the server's clock states one — and `writerStamp` is
       the heartbeat, which is what the parser writes for a record nothing has substituted. */
    serverStamp: null,
    writerStamp: ago(1_000),
    claimedAt: ago(60_000),
    displayName: "Their Mac",
    nonce: "n-them",
    authorizedAt: null,
    /* A tenure nobody pressed for describes itself as a takeover, which is what every record
       written before the verb existed says and what those installs do. */
    intent: "takeover",
    capabilities: [],
    ref: 101,
    ...over,
  };
}

function self(over: Partial<LeaseSelf> = {}): LeaseSelf {
  return { installId: "us", kind: "local", displayName: "This Mac", lastNonce: null, ...over };
}

const decide = (
  claims: ClaimRecord[],
  opts: { pressed?: boolean; staleAfterMs?: number; self?: LeaseSelf } = {},
): LeaseVerdict =>
  decideLease({
    self: opts.self ?? self(),
    claims,
    now: NOW,
    ...(opts.pressed === true ? { takeover: { authorizedAt: NOW, intent: "takeover" } } : {}),
    ...(opts.staleAfterMs === undefined ? {} : { staleAfterMs: opts.staleAfterMs }),
  });

/**
 * The two shapes an install cannot rank, and they are one rule with two spellings — a protocol
 * above ours, and a kind that is not in our closed set. Every row runs against both, because a
 * fix that reached only one of them is half-applied by construction: the protocol arm is what a
 * claim-envelope bump produces and the kind arm is what a `mobile` phone claim looks like to a
 * desktop that predates it, and they are the same `||` in the source.
 */
const UNRANKABLE: ReadonlyArray<[string, Partial<OrganizerClaim>]> = [
  ["a protocol above ours", { protocol: CLAIM_PROTOCOL + 1 }],
  ["a kind we do not recognise", { kind: "unknown" }],
];

describe("rule 1/2 — a live claim we cannot rank refuses the press", () => {
  for (const [label, shape] of UNRANKABLE) {
    /**
     * THE INVARIANT, and the row that must never go green for the wrong reason. Something is
     * organizing this mailbox, we cannot place it, and no authorization overrides that.
     */
    it(`refuses an authorized press while a lone claim with ${label} is fresh`, () => {
      const v = decide([claim({ ...shape, heartbeat: ago(1_000) })], { pressed: true });
      expect(v).toMatchObject({ verdict: "stand_down", reason: "organized_elsewhere:unknown" });
      // `by` is `OrganizerClaim | null` — null when the winner was MALFORMED — so the id is read
      // through the null rather than past it, and the row still names the machine it must name.
      expect(v.verdict === "stand_down" ? v.by?.installId : null).toBe("them");
    });

    /** Fresh by the reader's clock right up to the boundary — strictly less than one window. */
    it(`refuses an authorized press while a lone claim with ${label} is one millisecond inside the window`, () => {
      expect(decide([claim({ ...shape, heartbeat: ago(DEFAULT_STALE_AFTER_MS - 1) })], { pressed: true }))
        .toMatchObject({ verdict: "stand_down", reason: "organized_elsewhere:unknown" });
    });
  }
});

describe("…and stops refusing it once that claim has gone stale", () => {
  for (const [label, shape] of UNRANKABLE) {
    /**
     * The lane's finding. Before the liveness fix this row read `stand_down` /
     * `organized_elsewhere:unknown` for a claim of any age, so the ruling's "until stale or
     * released" had no "until" and a person whose other machine had stopped organizing months ago
     * could not take their own mailbox back from any door.
     */
    it(`admits an authorized press over a stale lone claim with ${label}`, () => {
      expect(decide([claim({ ...shape, heartbeat: ago(STALE) })], { pressed: true }))
        .toEqual({ verdict: "organize", renew: true, displace: [101], authorized: true });
    });

    /**
     * And WITHOUT a press it is offerable rather than taken — arm 8. `available` is the verdict
     * that puts the question to a person; becoming an organizer is always an explicit act. The row
     * matters on its own because `stand_down` here is what the surfaces render as "another
     * computer is organizing this mailbox", about a computer that stopped a year ago.
     */
    it(`reports a stale lone claim with ${label} as available rather than holding the mailbox`, () => {
      expect(decide([claim({ ...shape, heartbeat: ago(STALE) })]).verdict).toBe("available");
    });

    /**
     * THE DISCRIMINATOR BECOMES AN EQUALITY. This is the whole shape of the defect stated as one
     * assertion: the same folder, the same age, differing only in whether this build can rank the
     * record, decided differently — `organize` for a `cloud` claim and `stand_down` for the same
     * claim read as `unknown`. A record we cannot read is residue at exactly the age at which a
     * record we can read is residue.
     */
    it(`decides a stale lone claim with ${label} exactly as it decides a stale rankable one`, () => {
      const rankable = decide([claim({ kind: "cloud", heartbeat: ago(STALE) })], { pressed: true });
      const unrankable = decide([claim({ ...shape, heartbeat: ago(STALE) })], { pressed: true });
      expect(unrankable).toEqual(rankable);
    });
  }
});

describe("the reference is still IN THE FOLDER for every claim but the freshest", () => {
  /**
   * Folder-relative liveness exists so that two readers with two clocks cannot disagree about the
   * candidate set. Only the degenerate case moved, so a record that is NOT the folder's newest is
   * judged exactly as before — which is what keeps rule 1/2 from being reachable around by a
   * renewing install's own duplicate. Coalesce keeps one record per install; this row is the
   * hidden older one.
   */
  it("still refuses a press while a stale-looking unrankable record hides behind a fresh sibling", () => {
    const v = decide([
      claim({ installId: "them", protocol: CLAIM_PROTOCOL + 1, nonce: "n-old", heartbeat: ago(60_000), ref: 101 }),
      claim({ installId: "them", nonce: "n-new", heartbeat: ago(30_000), ref: 102 }),
    ], { pressed: true });
    expect(v).toMatchObject({ verdict: "stand_down", reason: "organized_elsewhere:unknown" });
  });

  /**
   * A DEAD CLOCK CANNOT LAPSE A LIVING ORGANIZER, AND AT THE DEFAULT WINDOW IT USED TO.
   *
   * This row is the whole reason the reference is taken over BELIEVABLE heartbeats rather than over
   * clamped ones, and it is a two-organizer sequence rather than an inconvenience. Ship values:
   * `MAX_FUTURE_SKEW_MS` equals `DEFAULT_STALE_AFTER_MS`, both ten minutes. A record dated 2099
   * clamped to `now + 10 min` dragged the reference there, so an honest record stamped ten seconds
   * ago sat `610s` behind it — at or past the `600s` window — and read STALE. Rule 1/2 then did not
   * fire, and an authorized press took the mailbox from an organizer that was alive and checking
   * in. Excluding unbelievable stamps from the reference removes the whole class: a stamp we have
   * already decided says nothing about renewal cannot lapse anything either.
   *
   * The DEFAULT window on purpose — a wider one hides it, which is how it survived.
   */
  it("keeps an honest unrankable record live beside a stamp dated 2099, at the default window", () => {
    const v = decide([
      claim({ installId: "them", protocol: CLAIM_PROTOCOL + 1, heartbeat: ago(10_000), ref: 101 }),
      claim({ installId: "skewed", nonce: "n-skew", heartbeat: new Date("2099-01-01T00:00:00.000Z"), ref: 102 }),
    ], { pressed: true });
    expect(v).toMatchObject({ verdict: "stand_down", reason: "organized_elsewhere:unknown" });
  });

  /**
   * …and in the other direction, which is the row that keeps the one above from being satisfied by
   * "a 2099 record makes everything live": a genuinely stale record beside the same 2099 stamp is
   * still stale, because the reference is the newest BELIEVABLE heartbeat and that is its own.
   */
  it("does not let a stamp dated 2099 revive a record that is stale by hours", () => {
    const v = decide([
      claim({ installId: "them", protocol: CLAIM_PROTOCOL + 1, heartbeat: ago(6 * 3_600_000), ref: 101 }),
      claim({ installId: "skewed", nonce: "n-skew", heartbeat: new Date("2099-01-01T00:00:00.000Z"), ref: 102 }),
    ], { pressed: true });
    expect(v.verdict).toBe("organize");
  });
});

/**
 * THE SHAPE THE WIRE ACTUALLY PRODUCES, and it is a different fixture from the rows above.
 *
 * Every row so far sets `kind: "unknown"` on a claim OBJECT, which is this release's own word for
 * "I could not place this". No install ever writes that word. What arrives on the wire is a kind
 * header carrying a value from a LATER release, which this build's parser folds to `"unknown"` on
 * the way in. A fixture that skips the round trip is measuring the fixture: it asserts the decision
 * table over a value the format never carries, and it would stay green if `parseClaim` stopped
 * folding an unrecognised kind at all, which is the one thing that makes rules 1/2 fire in the
 * field.
 *
 * So these two rows go through `formatClaim` → `parseClaim` with a real header value. The cast is
 * the point rather than a nuisance: `ClaimInput.kind` is this release's CLOSED set, so writing an
 * unknown kind from here is only possible by stepping outside the type — exactly the position a
 * newer install is in relative to this one.
 *
 * THE SUBJECT MOVED, AND THAT IS THE HISTORY WORTH KEEPING. It used to be `mobile`, a standalone
 * phone's kind, written by a later release than the one that could read it. Mail 0103 made
 * `mobile` a member of this set, so it stopped having the property under test — a control has to
 * be chosen from a subject that HAS it — and the fixture moved to a kind no release writes yet.
 * The premise below is asserted so the day THAT word is admitted this block says so rather than
 * quietly measuring an ordinary holder.
 */
describe("a kind from a later release, read by a build that predates it", () => {
  const futureClaim = (heartbeat: Date): OrganizerClaim => {
    const raw = formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "future-install", kind: "tablet", displayName: "Something newer",
      heartbeat, claimedAt: ago(2 * DEFAULT_STALE_AFTER_MS), nonce: "n-future",
    } as unknown as ClaimInput);
    const parsed = parseClaim(raw, 101);
    if (parsed === null || !("kind" in parsed)) throw new Error("fixture did not parse as a claim");
    // THE PREMISE, asserted rather than assumed: without the fold there is no unrankable claim
    // here at all and both rows below would be about an ordinary holder.
    expect(parsed.kind, "the fixture must arrive as a kind this build cannot place").toBe("unknown");
    return parsed;
  };

  it("refuses a press while the unrankable claim is fresh", () => {
    expect(decide([futureClaim(ago(5_000))], { pressed: true }))
      .toMatchObject({ verdict: "stand_down", reason: "organized_elsewhere:unknown" });
  });

  it("admits the press once that claim has been left un-renewed past the window", () => {
    expect(decide([futureClaim(ago(STALE))], { pressed: true }).verdict).toBe("organize");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  AN UNBELIEVABLE STAMP IS NOT A CLOCK
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Judging the folder's newest claim by the reader's clock closes the lone-claim hole and hands the
 * same permanence straight back on one shape, so the two clauses belong in one file. A heartbeat
 * beyond `now + MAX_FUTURE_SKEW_MS` is AHEAD of the reader's clock, so `now − heartbeat` is
 * negative and the record is "fresh" at every real instant — a lone claim dated 2099, written by a
 * machine with a dead clock battery, would refuse every press for ever.
 *
 * `Election.quiet` has always excluded such stamps; rules 1/2 never did, so the gate described a
 * folder as busy that the same election described as quiet. The ruling is that an unbelievable
 * stamp is NO EVIDENCE OF RENEWAL: a claim carrying one is live only while something believable in
 * the same folder is being renewed.
 *
 * The exception this makes to "a live claim is never takeable" is deliberate and named — a record
 * that is fresh only because its clock is broken is not evidence that anything is organizing the
 * mailbox — so the rows below fence it from both sides. Inside the tolerance a future stamp is
 * still fresh and still refuses; and a 2099 record beside a genuinely fresh one still refuses,
 * because then something IS organizing the mailbox and we still cannot rank the record.
 */
describe("a stamp beyond the skew tolerance is no evidence of renewal", () => {
  const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");

  for (const [label, shape] of UNRANKABLE) {
    it(`admits a press over a LONE claim with ${label} dated 2099`, () => {
      expect(decide([claim({ ...shape, heartbeat: FAR_FUTURE })], { pressed: true }).verdict)
        .toBe("organize");
    });

    /**
     * THE NARROW EDGE OF THE EXCEPTION. One millisecond inside the tolerance is a peer whose clock
     * runs ahead, which is ordinary and must be believed — treating it as gone is how both sides
     * decide they are the organizer. If this row ever goes red the exception has widened from
     * "unbelievable" to "in the future", and the fail-safe direction has been inverted.
     */
    it(`still refuses a press over a claim with ${label} stamped inside the skew tolerance`, () => {
      const inside = new Date(NOW.getTime() + MAX_FUTURE_SKEW_MS - 1);
      expect(decide([claim({ ...shape, heartbeat: inside })], { pressed: true }))
        .toMatchObject({ verdict: "stand_down", reason: "organized_elsewhere:unknown" });
    });

    /**
     * …and the exception does not reach a folder that IS being renewed. The 2099 record's own
     * stamp says nothing, so the answer comes from the believable record beside it: something is
     * organizing this mailbox, we cannot rank one of the records in it, and the press waits.
     */
    it(`still refuses a press over a 2099 claim with ${label} beside a genuinely fresh record`, () => {
      expect(decide([
        claim({ installId: "them", ...shape, heartbeat: FAR_FUTURE, ref: 101 }),
        claim({ installId: "alive", nonce: "n-alive", heartbeat: ago(5_000), ref: 102 }),
      ], { pressed: true })).toMatchObject({ verdict: "stand_down", reason: "organized_elsewhere:unknown" });
    });

    /** And once the believable record beside it lapses too, the folder is residue and yields. */
    it(`admits a press over a 2099 claim with ${label} beside a record that also lapsed`, () => {
      expect(decide([
        claim({ installId: "them", ...shape, heartbeat: FAR_FUTURE, ref: 101 }),
        claim({ installId: "gone", nonce: "n-gone", heartbeat: ago(STALE), ref: 102 }),
      ], { pressed: true }).verdict).toBe("organize");
    });
  }

  /**
   * A DEAD-CLOCK RECORD BESIDE AN INSTALL'S OWN FRESH ONE, which is the corner that decided where
   * the folder clock is read from.
   *
   * Coalesce keeps the NEWEST record per install and a 2099 duplicate IS the newest, so a clock
   * read over the coalesced set drops that install's genuinely fresh record and reports the folder
   * as quiet. `available` here is the failure, not `organize`: this reader has no press, so a
   * quiet folder would be reported offerable.
   *
   * ── WHAT THIS ROW DOES *NOT* MEASURE, corrected after review round 1 ────────────────────────
   *
   * Its comment used to end "…which is a false state on the one screen that exists to prevent
   * one". That was an overclaim about a row that only ever called `decideLease`. The SCREEN reads
   * `peekLease`, which coalesced before judging freshness and produced exactly the false state
   * this comment was congratulating itself for preventing — reported `stopped` for a renewing
   * install, and the worker's release certification then stamped the mailbox free. A reviewer
   * found it by reading the comment against the code rather than the code alone.
   *
   * The screen's half is now its own row, `reports an install as fresh on the strength of its RAW
   * records`, which asserts the preview AND the gate about one folder at one instant. This row is
   * the gate's half and says so.
   */
  it("does not read a folder as quiet because the renewing install also left a 2099 record", () => {
    const v = decide([
      claim({ installId: "them", nonce: "n-alive", heartbeat: ago(5_000), ref: 101 }),
      claim({ installId: "them", nonce: "n-deadclock", heartbeat: FAR_FUTURE, ref: 102 }),
    ]);
    expect(v).toMatchObject({ verdict: "stand_down" });
  });

  /**
   * THE PEEK SAYS THE SAME THING. A lone 2099 record is `stopped`, not `held` — the screen that
   * tells a person who is organizing their mailbox must not name a live organizer for a record the
   * gate has already stopped defending.
   */
  it("reports a lone 2099 unrankable record as stopped rather than held", () => {
    const p = peekLease({
      claims: [claim({ protocol: CLAIM_PROTOCOL + 1, heartbeat: FAR_FUTURE })],
      now: NOW,
    });
    expect(p.state).toBe("stopped");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A FOLDER NOBODY IS RENEWING HOLDS NOTHING LIVE — review round 1
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Three findings, one root, and the root is that the reader-clock bound was applied to a CLAIM
 * when it belongs to the FOLDER. Judging only the freshest record by the reader's clock leaves
 * every other record judged against a reference that may itself be a year old, so the "until stale
 * or released" that the rows above establish for a LONE claim evaporates the moment a second
 * record sits beside it — which is the ordinary shape of a folder that has been organized twice.
 *
 * These rows are the shapes the lone-claim table could not see, each one a sequence rather than a
 * property: a second record, a stamp one millisecond inside the tolerance, and a duplicate that
 * coalesce keeps.
 */
describe("a folder nobody is renewing holds nothing live", () => {
  const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");

  for (const [label, shape] of UNRANKABLE) {
    /**
     * FINDING 1 (High). TWO stale records, and the unrankable one is not the newest — so the
     * reader-clock arm never sees it and the folder-relative arm sees a one-second difference and
     * calls it live. A permanent lockout with two records where one record recovers, which is the
     * shape a reader would least expect: adding an OLDER sibling made the mailbox unrecoverable.
     *
     * Both records are stale by a year. Nothing has renewed here since before the press was even
     * possible, and the folder is residue whichever record you look at.
     */
    it(`admits a press when a stale claim with ${label} is not the newest stale record`, () => {
      const year = 365 * 24 * 3_600_000;
      expect(decide([
        claim({ installId: "them", ...shape, heartbeat: ago(year), ref: 101 }),
        claim({ installId: "other", nonce: "n-other", heartbeat: ago(year - 1_000), ref: 102 }),
      ], { pressed: true }).verdict).toBe("organize");
    });

    /**
     * FINDING 2 (High). A stamp ONE MILLISECOND inside the skew tolerance drags the reference
     * forward by nearly a whole window, which lapses an organizer that is renewing right now — and
     * rule 6 then puts its live record in `displace`. Two organizers, and an expunge of a claim we
     * cannot read.
     *
     * The tolerance exists so that a peer whose clock runs ahead is not treated as GONE. It was
     * never meant to let that peer's stamp age everybody else, and the difference is the whole
     * finding: believing a skewed peer is alive is not the same as believing its clock.
     */
    it(`refuses a press while a claim with ${label} renews beside a stamp inside the tolerance`, () => {
      const v = decide([
        claim({ installId: "them", ...shape, heartbeat: ago(10_000), ref: 101 }),
        claim({ installId: "skewed", nonce: "n-skew", heartbeat: new Date(NOW.getTime() + MAX_FUTURE_SKEW_MS - 1), ref: 102 }),
      ], { pressed: true });
      expect(v).toMatchObject({ verdict: "stand_down", reason: "organized_elsewhere:unknown" });
    });

    /** …and the live record is not expunged either, which is the half rule 6 owns. */
    it(`never displaces a claim with ${label} that renews beside a stamp inside the tolerance`, () => {
      const v = decide([
        claim({ installId: "them", ...shape, heartbeat: ago(10_000), ref: 101 }),
        claim({ installId: "skewed", nonce: "n-skew", heartbeat: new Date(NOW.getTime() + MAX_FUTURE_SKEW_MS - 1), ref: 102 }),
      ], { pressed: true });
      expect(v.verdict === "organize" ? v.displace : []).not.toContain(101);
    });
  }

  /**
   * FINDING 3 (High), and it is the one with a WRITE at the end of it. The preview coalesces before
   * it judges freshness, and coalesce keeps the newest heartbeat per install — so an install that
   * is renewing honestly, and that also left a 2099 cleanup residue, is represented by the residue
   * alone and reported `fresh: false`. `apps/worker/src/index.ts` certifies a mailbox release only
   * when no holder is fresh and nothing is unreadable, so it stamps the mailbox RELEASED while
   * another install is demonstrably renewing it — and the gate, reading the raw list, says
   * `stand_down` about the same folder at the same instant.
   *
   * The row asserts the preview, because that is what the worker consumes; the gate's own answer
   * is asserted beside it so the two cannot drift apart again.
   */
  it("reports an install as fresh on the strength of its RAW records, not the one coalesce keeps", () => {
    const claims = [
      claim({ installId: "them", nonce: "n-live", heartbeat: ago(5_000), ref: 101 }),
      claim({ installId: "them", nonce: "n-residue", heartbeat: FAR_FUTURE, ref: 102 }),
    ];
    const p = peekLease({ claims, now: NOW });
    expect(p.state, "the preview must not report a renewing install as stopped").toBe("held");
    expect(p.holders.find((h) => h.installId === "them")).toMatchObject({ fresh: true });
    // The gate's answer about the same folder at the same instant, so a later change cannot move
    // one without the other going red.
    expect(decide(claims).verdict).toBe("stand_down");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE PREVIEW NAMES A MACHINE, AND A STAMP NOBODY BELIEVES MUST NOT CHOOSE IT — review round 2
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `holders[0]` is read as "the organizer" by three consumers, so the ORDER of that list is a
 * product decision and not a presentation detail. Round two found the list sorted on the raw
 * heartbeat, which let a 2099 residue decide the name — and found the renewal evidence uncapped
 * where the reference is capped, which is invisible at every positive window and wrong at zero.
 */
describe("the preview's own answers", () => {
  const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");
  const later2099 = new Date("2099-01-02T00:00:00.000Z");

  /**
   * TWO INSTALLS, EACH WITH A LIVE RECORD AND A 2099 RESIDUE, and the election picks A on
   * incumbency. The preview used to put B first because B's residue was a day later in 2099, so
   * the screen named the machine that had just been stood down. Asserted as the AGREEMENT between
   * the two answers rather than as B-not-first, because the property is that one folder produces
   * one story.
   */
  it("names the same install the election does, not whichever residue is later in 2099", () => {
    const claims = [
      claim({ installId: "aaa", nonce: "n-a-live", heartbeat: ago(5_000), claimedAt: ago(600_000), ref: 101 }),
      claim({ installId: "aaa", nonce: "n-a-residue", heartbeat: FAR_FUTURE, claimedAt: ago(600_000), ref: 102 }),
      claim({ installId: "bbb", nonce: "n-b-live", heartbeat: ago(5_000), claimedAt: ago(60_000), ref: 103 }),
      claim({ installId: "bbb", nonce: "n-b-residue", heartbeat: later2099, claimedAt: ago(60_000), ref: 104 }),
    ];
    // The election's own answer: the older tenure continues, and the other install stands down.
    expect(decide(claims, { self: self({ installId: "aaa" }) }).verdict).toBe("organize");
    const stood = decide(claims, { self: self({ installId: "bbb" }) });
    expect(stood.verdict).toBe("stand_down");
    expect(stood.verdict === "stand_down" ? stood.by?.installId : null).toBe("aaa");
    // …and the screen names that same install.
    expect(peekLease({ claims, now: NOW }).holders[0]?.installId).toBe("aaa");
  });

  /**
   * ORDER-FREE, which is the half a single fixture cannot show. IMAP does not promise an order,
   * and a list whose head depends on the order the server handed the messages over names a
   * different machine to two readers of one folder.
   */
  it("puts the same install first whichever order the server hands the records over in", () => {
    const build = (): ClaimRecord[] => [
      claim({ installId: "aaa", nonce: "n-a", heartbeat: ago(5_000), ref: 101 }),
      claim({ installId: "bbb", nonce: "n-b", heartbeat: ago(5_000), ref: 102 }),
    ];
    const forward = peekLease({ claims: build(), now: NOW }).holders.map((h) => h.installId);
    const reversed = peekLease({ claims: build().reverse(), now: NOW }).holders.map((h) => h.installId);
    expect(forward).toEqual(reversed);
  });

  /**
   * THE ZERO WINDOW, which `apps/worker`'s configuration accepts. The reference is capped at `now`
   * and the renewal evidence was not, and the two spellings agree at every positive window — an
   * ahead stamp gives `now − now = 0`, fresh either way — so only `staleAfterMs = 0` tells them
   * apart: an uncapped residue at `now + 5 min` satisfied `isFresh` and held the mailbox for five
   * minutes under a window of zero.
   */
  it("holds nothing under a zero window, not even a record stamped in the future", () => {
    const p = peekLease({
      claims: [claim({ installId: "them", heartbeat: new Date(NOW.getTime() + 5 * 60_000), ref: 101 })],
      now: NOW,
      staleAfterMs: 0,
    });
    expect(p.state).toBe("stopped");
  });

  /** …and the control beside it: a positive window is unaffected by the cap. */
  it("still reports a record stamped slightly in the future as held under an ordinary window", () => {
    const p = peekLease({
      claims: [claim({ installId: "them", heartbeat: new Date(NOW.getTime() + 5 * 60_000), ref: 101 })],
      now: NOW,
    });
    expect(p.state).toBe("held");
  });
});

describe("the positive controls — the ordinary cases the refusal must not eat", () => {
  /**
   * A RELEASED claim is admitted. Releasing is expunging the record, so the folder is empty and
   * this is arm 4 — nobody has ever organized this mailbox, or the last organizer left cleanly.
   * Asserted here rather than assumed because a refusal rule with no admitting row has no evidence
   * it admits the right person.
   */
  it("organizes on a folder whose only claim was released", () => {
    expect(decide([], { pressed: true }))
      .toEqual({ verdict: "organize", renew: true, displace: [], authorized: true });
  });

  /**
   * OWN-ROLE RESUMPTION IS UNTOUCHED. `runElection`'s own liveness stays folder-relative and clock
   * free, which is what §4's "continuing is not becoming" rests on: a laptop that slept for a week
   * wakes to find only its own claim in the folder, is the newest thing in it, and resumes without
   * asking anybody. If this row ever goes red, the fix has been applied to the election instead of
   * to the unrankable scan.
   */
  it("resumes its own role over a lone claim of its own that is stale by a week", () => {
    expect(decide([claim({ installId: "us", nonce: "written-before-the-sleep", heartbeat: ago(7 * 24 * 3_600_000) })]))
      .toEqual({ verdict: "organize", renew: true, displace: [], authorized: false });
  });

  /** A live claim we CAN rank still holds the mailbox against an install nobody pressed for. */
  it("still stands down for a fresh rankable claim with no press of our own", () => {
    expect(decide([claim({ kind: "cloud" })]))
      .toMatchObject({ verdict: "stand_down", reason: "organized_elsewhere:cloud" });
  });
});

/**
 * THE PREVIEW AND THE GATE ANSWER THE SAME QUESTION. `peekLease` runs the unrankable scan too, and
 * it ran a second copy of the folder-relative test — so the two shared the defect and agreed with
 * each other about a stale lone record: the preview said `held`, and the button it offered led to
 * a gate that refused for ever. Both now read one predicate, so the agreement is by construction
 * rather than by two authors happening to write the same expression.
 */
describe("peekLease agrees with the gate about a lone unrankable record", () => {
  const peek = (claims: ClaimRecord[]): ReturnType<typeof peekLease> =>
    peekLease({ claims, now: NOW });

  it("reports a FRESH lone unrankable record as held and unknown", () => {
    const p = peek([claim({ protocol: CLAIM_PROTOCOL + 1, heartbeat: ago(1_000) })]);
    expect(p.state).toBe("held");
    expect(p.holders[0]).toMatchObject({ kind: "unknown", fresh: true });
  });

  it("reports a STALE lone unrankable record as stopped", () => {
    const p = peek([claim({ protocol: CLAIM_PROTOCOL + 1, heartbeat: ago(STALE) })]);
    expect(p.state).toBe("stopped");
    expect(p.holders[0]).toMatchObject({ fresh: false });
  });

  /**
   * Stated as the correspondence rather than as two independent expectations, because the
   * correspondence is the property: `held` from the preview and `organized_elsewhere:unknown` from
   * the gate must arrive together for one folder, at one instant.
   *
   * IT IS GREEN IN BOTH WORLDS BY DESIGN, and that is worth saying plainly so nobody reads it as
   * evidence for the fix. Before the fix both sides answered "held / refused" at every age — they
   * shared the defect, which is exactly why neither could see it. This row pins that they never
   * DIVERGE; the two rows above pin which answer is right. It does go red if only one of the two
   * call sites is changed, which is the regression it exists for.
   */
  it("never diverges from the gate across the whole age range", () => {
    for (const age of [0, 1_000, DEFAULT_STALE_AFTER_MS - 1, DEFAULT_STALE_AFTER_MS, STALE, 400 * 24 * 3_600_000]) {
      const claims = [claim({ protocol: CLAIM_PROTOCOL + 1, heartbeat: ago(age) })];
      const refused = decide(claims, { pressed: true }).verdict === "stand_down";
      expect(peek(claims).state === "held", `age ${age}ms`).toBe(refused);
    }
  });

  /**
   * THE SAME DEAD-CLOCK CASE ON THE PEEK, which reads its reference through the same helper and so
   * had the same defect: the honest record read stale, the preview reported an ordinary `cloud`
   * holder for a record the gate was still refusing every press over, and the takeover it offered
   * would have no-opped — on the one surface that exists to tell a person the truth about who
   * holds their mailbox. Default window, for the reason the gate row gives.
   */
  it("keeps an honest unrankable record unknown beside a stamp dated 2099", () => {
    const p = peekLease({
      claims: [
        claim({ installId: "them", protocol: CLAIM_PROTOCOL + 1, heartbeat: ago(10_000), ref: 101 }),
        claim({ installId: "skewed", nonce: "n-skew", heartbeat: new Date("2099-01-01T00:00:00.000Z"), ref: 102 }),
      ],
      now: NOW,
    });
    expect(p.holders.find((h) => h.installId === "them")).toMatchObject({ kind: "unknown", fresh: true });
  });
});

/**
 * ONE FOLDER, ONE ORGANIZER NAMED — by the gate, the peek and the peek's answer alike
 * (LEASE-SCREEN-AND-ELECTION-COMPARATORS-DIVERGE). The pair at "names the same install the election
 * does" gives both live records the SAME heartbeat, so recency tied and the install id happened to
 * land on the election's incumbent; that fixture measures the tie, not the order. The inverted tie
 * below parts the two: `bbb` is the incumbent (older tenure) and `aaa` the newer renewer, both
 * unpressed and live. Mutation watched red: the peek's order taken from recency instead of `ranked`.
 */
describe("the gate, the peek and its answer name one holder", () => {
  const INVERTED = (): OrganizerClaim[] => [
    claim({ installId: "bbb", nonce: "n-b", claimedAt: ago(600_000), heartbeat: ago(120_000), writerStamp: ago(120_000), ref: 101 }),
    claim({ installId: "aaa", nonce: "n-a", claimedAt: ago(60_000), heartbeat: ago(5_000), writerStamp: ago(5_000), ref: 102 }),
  ];
  const ioOver = (claims: OrganizerClaim[]) => ({
    listClaims: async () => claims.map((c) => ({ ref: c.ref, raw: formatClaim({ ...c, kind: c.kind === "unknown" ? "local" : c.kind }) })),
  });
  const readers = async (claims: OrganizerClaim[]) => {
    const v = decide(claims, { self: self({ installId: "ccc" }) });
    const answered = await answerLeasePeek({ io: ioOver(claims), now: NOW });
    return {
      gate: v.verdict === "stand_down" ? v.by?.installId : `(${v.verdict})`,
      peek: peekLease({ claims, now: NOW }).holders[0]?.installId,
      answer: answered.answer === "held" ? answered.holder.installId : `(${answered.answer})`,
    };
  };

  it("the inverted tie: the incumbent is named by all three, not the newer renewer", async () => {
    expect(await readers(INVERTED())).toEqual({ gate: "bbb", peek: "bbb", answer: "bbb" });
  });

  it("CONTROL — with a press the two orders already agreed, and still do", async () => {
    const claims = INVERTED().map((c) => (c.installId === "aaa" ? { ...c, authorizedAt: ago(30_000) } : c));
    expect(await readers(claims)).toEqual({ gate: "aaa", peek: "aaa", answer: "aaa" });
  });
});

/**
 * AN UNRANKABLE HOLDER IS NAMED ONE WAY (STAND-DOWN-AND-PEEK-NAME-AN-UNRANKABLE-HOLDER-TWO-WAYS). A
 * claim of a newer protocol whose kind header says `cloud` stood a worker down as `cloud` and the
 * reader's next peek called it `unknown`. `holderKind` is the one namer both take: a header this
 * build cannot rank is not evidence, so neither names Cloud from it.
 */
describe("one holder, one word", () => {
  it("a newer protocol's `cloud` header is `unknown` on the stand-down and on the peek", () => {
    const c = claim({ kind: "cloud", protocol: CLAIM_PROTOCOL + 1 });
    const v = decide([c]);
    expect({
      verdict: v.verdict,
      gateKind: v.verdict === "stand_down" ? v.by?.kind : null,
      peekKind: peekLease({ claims: [c], now: NOW }).holders[0]?.kind,
      namer: holderKind(c),
    }).toEqual({ verdict: "stand_down", gateKind: "unknown", peekKind: "unknown", namer: "unknown" });
  });

  it("CONTROL — a rankable cloud holder is `cloud` on both", () => {
    const c = claim({ kind: "cloud" });
    const v = decide([c]);
    expect({
      gateKind: v.verdict === "stand_down" ? v.by?.kind : null,
      peekKind: peekLease({ claims: [c], now: NOW }).holders[0]?.kind,
    }).toEqual({ gateKind: "cloud", peekKind: "cloud" });
  });
});
