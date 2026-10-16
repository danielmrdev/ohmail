import { describe, it, expect } from "vitest";
import {
  AWAY_ANSWERABLE_PILES, readAwayPiles, type AwayPile,
} from "@trafficflow/core/away-scope";
import {
  makeProfileDoc, formatProfileMessage, parseProfileMessage, isMalformedProfile,
  type OrganizerProfilePayload,
} from "@trafficflow/core/adapters/organizer-profile";
import { AWAY_PILES, validateProfileUpdatePayload } from "@trafficflow/db";
import { awayPilesFromRequest } from "../src/away-responder-service.js";
import { ServiceError } from "../src/errors.js";

/**
 * ═══ ONE MEMBER SET FOR THE AWAY RESPONDER'S PILE SCOPE ════════════════════════════════════
 *
 * ── THE SHAPE OF THE DEFECT ────────────────────────────────────────────────────────────────
 *
 * `piles` crosses an install boundary through two contracts written three weeks apart: the
 * published profile DOCUMENT (`ProfileAwayResponder`) and the `profile.update` REQUEST
 * (`ProfileAwayResponderPatch`). Each had its own narrowing — `pilesOf` in the document's
 * parser, `validPiles` on the settings endpoint — and nothing anywhere asserted the two admitted
 * the same members. That is the wire-format-has-three-homes trap with two of the three homes
 * written twice: the day somebody added a pile to one list, a scope would have left one door and
 * been refused at the other, and the person would have been told their edit was saved.
 *
 * ── WHAT IS ASSERTED, AND WHY IT IS NOT "THE TWO LISTS ARE EQUAL" ──────────────────────────
 *
 * The two doors differ on purpose and the difference is directional. The document is a published
 * format read by installs of every version, so a member THIS build does not know is a newer
 * ohmail's and is carried through for the importer to decide about; the request is this build
 * talking to itself, so an unknown member is a refusal somebody can act on. The invariant is
 * therefore a SUBSET, in the safe direction: every member the request admits, the document
 * admits and keeps. Its contrary is the failure — a scope that travels and is then dropped.
 *
 * ── WHY IT DRIVES THE DOORS ────────────────────────────────────────────────────────────────
 *
 * Three real readers, no reimplementation: the document's parser over a formatted message, the
 * endpoint's own narrowing (`awayPilesFromRequest`, exported for exactly this), and the drain
 * that APPLIES a request at the holder (`validateProfileUpdatePayload`, which restates the set
 * as a literal because db may not import core). A test that spelled the member test again would
 * be measuring itself.
 *
 * ── WHY THE CASES COME FROM `AWAY_PILES` AND NOT FROM `AWAY_ANSWERABLE_PILES` ──────────────
 *
 * MEASURED: driven off core's own list, this file answered GREEN to a member being deleted from
 * it — `it.each` simply generated one case fewer, and a suite that enumerates the set under test
 * cannot see the set shrink. The cases therefore come from `AWAY_PILES`, the db drain's
 * INDEPENDENT literal (db may not import core, which is the only reason a second spelling is
 * tolerated at all), and the first assertion below holds the two equal in BOTH directions. A
 * member removed from either home now leaves the other naming it, and one of the doors refusing
 * it.
 */

/** Not a pile, and deliberately a real folder: `ohmail/Quarantine` is never answered. */
const NOT_A_MEMBER = "ohmail/Quarantine";
/** A member only a NEWER ohmail would know. The document carries it; the request refuses it. */
const FUTURE_MEMBER = "ohmail/SomethingNext";

function payloadWith(piles: string[]): OrganizerProfilePayload {
  return {
    screener: [], rules: [], notifyRules: [], tagNames: [], signature: null,
    awayResponder: {
      enabled: true, body: "away", startsAt: null, endsAt: null,
      // `everyone`, so the Screener member is never filtered by the audience coupling — this
      // file is about the MEMBER SET and nothing else.
      audience: "everyone", throttle: "per_day", piles,
    },
  };
}

/** What the DOCUMENT door admits: format a real profile message, parse it, read the scope back. */
function throughDocument(piles: string[]): string[] | "refused" | "unstated" {
  const raw = formatProfileMessage(
    makeProfileDoc(payloadWith(piles), {
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      producer: { kind: "test", version: "0" },
    }),
    { installId: "11111111-1111-4111-8111-111111111111" },
  );
  const rec = parseProfileMessage(raw);
  if (rec === null || isMalformedProfile(rec)) return "refused";
  // `doc` is present only for `status: "ok"`; a `newer` document is not this build's to read.
  const away = rec.doc?.awayResponder;
  if (away === null || away === undefined) return "refused";
  return away.piles === undefined ? "unstated" : away.piles;
}

/** What the REQUEST door admits — the endpoint's own narrowing, not a copy of it. */
function throughRequest(piles: unknown): string[] | "refused" {
  try {
    return awayPilesFromRequest(piles);
  } catch (err) {
    if (err instanceof ServiceError) return "refused";
    throw err;
  }
}

/** What the DRAIN admits — the holder that applies the request it received. */
function throughDrain(piles: unknown): string[] | "refused" {
  const v = validateProfileUpdatePayload({
    awayResponder: {
      enabled: true, body: "away", startsAt: null, endsAt: null,
      audience: "everyone", throttle: "per_day", piles,
    },
  });
  const got = v?.awayResponder?.piles;
  return got === undefined ? "refused" : [...got];
}

/**
 * The enumeration source: the DRAIN's own literal, which is written in a package that cannot
 * import core. Independent of the list every door under test narrows against, which is what lets
 * this file see one of them move.
 */
const WIRE_SET = [...AWAY_PILES].sort();

describe("the two independent spellings of the member set agree", () => {
  /**
   * BOTH DIRECTIONS, and the anchor for everything below: the cases are generated from
   * `AWAY_PILES`, so a member added to core alone would otherwise never be driven, and a member
   * removed from core alone would otherwise only shrink the case list.
   */
  it("core's closed set and the drain's literal name the same piles", () => {
    expect(WIRE_SET, "core's set and the drain's literal have drifted")
      .toEqual([...AWAY_ANSWERABLE_PILES].sort());
  });
});

describe("every member of the closed set survives every door", () => {
  it.each(WIRE_SET)("%s", (member) => {
    expect(throughRequest([member]), "the request door refused a member of its own set")
      .toEqual([member]);
    expect(throughDocument([member]), "the published document dropped a member a request admits")
      .toEqual([member]);
    expect(throughDrain([member]), "the drain refused a member the request door sent")
      .toEqual([member]);
  });

  it("and the whole set at once, through all three", () => {
    expect(throughRequest(WIRE_SET)).toEqual(WIRE_SET);
    expect(throughDocument(WIRE_SET)).toEqual(WIRE_SET);
    expect(throughDrain(WIRE_SET)).toEqual(WIRE_SET);
  });
});

describe("the request's admitted set is a SUBSET of the document's", () => {
  /**
   * The invariant itself, driven rather than restated: whatever the request door lets through,
   * the document door keeps. Mutating either home's list reddens this — a member removed from
   * `AWAY_ANSWERABLE_PILES` leaves the request door refusing what the document still carries;
   * a member the document alone dropped fails the equality above.
   */
  it("holds for every member, and the two cannot drift without this going red", () => {
    for (const member of WIRE_SET) {
      const req = throughRequest([member]);
      expect(req, `the request door refuses ${member}`).not.toBe("refused");
      expect(
        throughDocument(req as string[]),
        `the document does not carry ${member}, which a request may send`,
      ).toEqual(req);
    }
  });

  it("is a subset and NOT an equality — the document carries a newer ohmail's member", () => {
    // The direction that makes this a subset rather than two equal lists. A document written by
    // a later build round-trips through this one with its scope intact; the importer decides.
    expect(throughDocument([FUTURE_MEMBER])).toEqual([FUTURE_MEMBER]);
    expect(throughRequest([FUTURE_MEMBER])).toBe("refused");
  });
});

describe("a non-member is refused at the doors that are this build talking to itself", () => {
  it("the request door refuses it", () => {
    expect(throughRequest([NOT_A_MEMBER])).toBe("refused");
    expect(throughRequest([WIRE_SET[0]!, NOT_A_MEMBER])).toBe("refused");
  });

  it("the drain refuses it, rather than filtering it to a narrower scope", () => {
    expect(throughDrain([NOT_A_MEMBER])).toBe("refused");
    expect(throughDrain([WIRE_SET[0]!, NOT_A_MEMBER])).toBe("refused");
  });
});

describe("the one narrowing answers the same three states at both doors", () => {
  it("absent is UNSTATED at both, and never 'answer nobody'", () => {
    expect(readAwayPiles(undefined, "request").state).toBe("unstated");
    expect(readAwayPiles(undefined, "document").state).toBe("unstated");
    expect(readAwayPiles(null, "request").state).toBe("unstated");
    expect(readAwayPiles(null, "document").state).toBe("unstated");
    // And at the endpoint, absent takes the narrow default rather than the wide one.
    expect(throughRequest(undefined)).toEqual(["INBOX"]);
  });

  it("an explicit empty list is a real answer at both, and is kept", () => {
    expect(readAwayPiles([], "request")).toEqual({ state: "stated", piles: [] });
    expect(readAwayPiles([], "document")).toEqual({ state: "stated", piles: [] });
    expect(throughRequest([])).toEqual([]);
    expect(throughDocument([])).toEqual([]);
  });

  it("duplicates collapse at both — the value is a SET", () => {
    const m = WIRE_SET[0]!;
    expect(throughRequest([m, m])).toEqual([m]);
    expect(throughDocument([m, m])).toEqual([m]);
  });

  it("a non-string member is UNREADABLE at both, and reads as a shape fault", () => {
    for (const door of ["request", "document"] as const) {
      expect(readAwayPiles([1], door)).toEqual({ state: "unreadable", reason: "not_an_array" });
      expect(readAwayPiles("INBOX", door)).toEqual({ state: "unreadable", reason: "not_an_array" });
    }
    // A KNOWN KEY WITH THE WRONG TYPE IS NOT AN ABSENT ONE: the document refuses the whole
    // responder section rather than reading an unbounded scope as unstated.
    expect(throughDocument([1] as unknown as string[])).toBe("refused");
    expect(throughRequest([1])).toBe("refused");
  });

  it("the request door names the offending member, the document door never has one to name", () => {
    expect(readAwayPiles([NOT_A_MEMBER], "request"))
      .toEqual({ state: "unreadable", reason: "not_a_member", member: NOT_A_MEMBER });
    expect(readAwayPiles([NOT_A_MEMBER], "document"))
      .toEqual({ state: "stated", piles: [NOT_A_MEMBER] });
  });
});

/** The type is exercised, so a member added to the set without a `AwayPile` home is a build red. */
const _pinned: readonly AwayPile[] = AWAY_ANSWERABLE_PILES;
void _pinned;
