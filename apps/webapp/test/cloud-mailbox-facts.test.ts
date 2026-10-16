/**
 * THE WIRE→SHELL NARROWING, DRIVEN DIRECTLY.
 *
 * This file exists because of a mutation that PASSED. On the desktop's equivalent seam, inverting
 * the absent-role default — absent ⇒ `reader` instead of `organizer` — left every component test
 * green, because they all inject `MailboxFacts` through a mocked provider and none of them reaches
 * the mapping. The line that was invisible is the one that decides whether an "Organize here
 * instead" banner appears on every mailbox of every install whose API predates the column.
 *
 * The web seam had the same hole and the same fix: `toMailboxFacts` is a plain function now, and
 * this drives it with plain objects. What it pins is ABSENT-FIELD BEHAVIOUR, which is the only
 * part of a narrowing that can be wrong in a way nothing else notices.
 */
import { describe, expect, it } from "vitest";
import { toMailboxFacts } from "../app/(product)/mailbox/mailbox-facts";
import type { MailboxDTO } from "../app/api-client";

/** The narrowest row the wire can carry: every optional field absent. */
const BARE = {
  id: "mb-1",
  provider: "imap",
  address: "mila@example.org",
  displayName: null,
  status: "connected",
  lastSyncAt: null,
} as MailboxDTO;

describe("the organizing role's absent default", () => {
  it("an ABSENT role is `organizer` — the direction that offers no claim", () => {
    // The mutation this is here for. Inverted, an install talking to an API that predates the
    // column grows a claim banner on every mailbox it already organizes, each offering a button
    // the server refuses.
    expect(toMailboxFacts(BARE).organizerRole).toBe("organizer");
  });

  it("an UNRECOGNISED role is `organizer` too, never passed through", () => {
    const weird = { ...BARE, organizerRole: "custodian" } as unknown as MailboxDTO;
    expect(toMailboxFacts(weird).organizerRole).toBe("organizer");
  });

  it("`reader` is the only value that produces a reader", () => {
    expect(toMailboxFacts({ ...BARE, organizerRole: "reader" }).organizerRole).toBe("reader");
    expect(toMailboxFacts({ ...BARE, organizerRole: "organizer" }).organizerRole).toBe("organizer");
  });
});

describe("the consent stamp keeps absent and null apart", () => {
  it("ABSENT stays `undefined` — it must not become the claim-eligible null", () => {
    // The whole reason there is no `?? null` on this line. The claim predicate reads `=== null`;
    // were absent collapsed into null here, that predicate would be satisfied on every row an
    // older API serves and the offer would appear everywhere.
    expect(toMailboxFacts(BARE).organizeConsentedAt).toBeUndefined();
  });

  it("`null` survives as null — nobody has agreed to this mailbox", () => {
    expect(toMailboxFacts({ ...BARE, organizeConsentedAt: null }).organizeConsentedAt).toBeNull();
  });

  it("a stamp survives verbatim", () => {
    const at = "2026-08-01T09:00:00.000Z";
    expect(toMailboxFacts({ ...BARE, organizeConsentedAt: at }).organizeConsentedAt).toBe(at);
  });
});

describe("the holder travels whole, or not at all", () => {
  it("an absent holder stays ABSENT, and an absent state is still `null`", () => {
    /* ── THIS CASE USED TO ASSERT THE OPPOSITE, AND ITS PREMISE WAS THE DEFECT ────────────────
     *
     * It read *"an absent holder is `null`, which is the shape the banner tests"*, and for the
     * BANNER that is true: `readerHolder` maps both to "nobody" because neither names an install,
     * so the sentence is the same either way and the mapper's normalization cost nothing.
     *
     * It is not the only consumer any more. `holderVerdict` asks whether a read ANSWERED the
     * question — the first-run claim question routes on it, and the screen after that one is
     * where a takeover is authorized — and for that consumer the two are opposite: the DTO
     * declares this field non-optional and the service projects it unconditionally, so absent can
     * only be an API older than the field. Normalizing it here made the "no answer" arm
     * unreachable and let a lagging read take the claim screen away.
     *
     * `organizerState` is unchanged and deliberately so: it has no such consumer, its absence and
     * its `null` mean one thing ("nobody is renewing"), and the field is read only by screens. */
    expect("organizedBy" in toMailboxFacts(BARE),
      "a field the API never sent was invented as an answer").toBe(false);
    expect(toMailboxFacts({ ...BARE, organizedBy: null }).organizedBy,
      "the answer 'nobody organizes this' was dropped").toBeNull();
    expect(toMailboxFacts(BARE).organizerState).toBeNull();
  });

  it("a named holder is forwarded with its three fields intact", () => {
    const facts = toMailboxFacts({
      ...BARE,
      organizerRole: "reader",
      organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
      organizerState: "held",
    });
    expect(facts.organizedBy).toEqual({
      kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z",
    });
    expect(facts.organizerState).toBe("held");
  });

  it("`stopped` is preserved rather than collapsed into `held`", () => {
    // The two want opposite sentences on screen. A seam that collapsed them would make one of
    // the lease's verdicts unreachable by any copy.
    expect(toMailboxFacts({ ...BARE, organizerState: "stopped" }).organizerState).toBe("stopped");
  });
});

describe("the two fields a `?? null` has broken before", () => {
  it("an absent import stamp stays absent, so the strip degrades to growth-only", () => {
    expect(toMailboxFacts(BARE).initialImportCompletedAt).toBeUndefined();
  });

  it("a null import stamp stays null — a real, ongoing import", () => {
    expect(toMailboxFacts({ ...BARE, initialImportCompletedAt: null }).initialImportCompletedAt)
      .toBeNull();
  });

  it("an absent pending-move count stays absent, never 0", () => {
    expect(toMailboxFacts(BARE).pendingMoves).toBeUndefined();
    expect(toMailboxFacts({ ...BARE, pendingMoves: 0 }).pendingMoves).toBe(0);
  });
});

/**
 * ═══ ABSENT AND `null` ARE DIFFERENT ANSWERS ABOUT WHO ORGANIZES A MAILBOX ═══════════════════
 *
 * `toMailboxFacts` read `m.organizedBy ?? null`, so a DTO that did not CARRY the field arrived
 * downstream as the server saying "nobody organizes this mailbox". The DTO declares the field
 * non-optional and the service projects it unconditionally, so absent can only be an API older
 * than the field — a read that did not ANSWER.
 *
 * The first-run claim question routes on that distinction, and with it collapsed here the arm
 * written for "no answer" could never be entered: a lagging read took the claim screen away, and
 * the screen after it is where a takeover is authorized.
 *
 * WATCH IT FAIL: put `?? null` back — the first case reds with the key present and `null`.
 */
describe("the hosted mapper keeps 'the API did not say' apart from 'nobody organizes it'", () => {
  const row = (over: Record<string, unknown>) => ({
    id: "mb-h", address: "h@example.invalid", status: "connected", lastSyncAt: null,
    ...over,
  }) as unknown as Parameters<typeof toMailboxFacts>[0];

  it("an OMITTED organizedBy stays omitted", () => {
    const got = toMailboxFacts(row({}));
    expect("organizedBy" in got, "a field the API never sent was invented as 'nobody'")
      .toBe(false);
  });

  it("CONTROL — an explicit null is carried as null, and an object is carried whole", () => {
    const free = toMailboxFacts(row({ organizedBy: null }));
    expect("organizedBy" in free, "the answer 'nobody organizes this' was dropped").toBe(true);
    expect(free.organizedBy).toBeNull();

    const held = toMailboxFacts(row({
      organizedBy: { kind: "cloud", name: "ohmail Cloud", since: null },
    }));
    expect(held.organizedBy).toEqual({ kind: "cloud", name: "ohmail Cloud", since: null });
  });
});

/* THE HOSTED DOOR'S "HAVE I LOOKED" (CLOUD-SETUP-OFFERS-AGREE-BEFORE-THE-HOLDER-IS-READ): setup
   withholds Agree on `false`, so the seam carries it and leaves an older API's silence absent. */
describe("the hosted mapper carries whether the door has looked at the holder", () => {
  it("`false` survives — a reader row nothing has peeked for", () => {
    expect(toMailboxFacts({ ...BARE, organizerChecked: false }).organizerChecked).toBe(false);
  });
  it("CONTROL: `true` survives, and an absent field stays absent", () => {
    expect(toMailboxFacts({ ...BARE, organizerChecked: true }).organizerChecked).toBe(true);
    expect("organizerChecked" in toMailboxFacts(BARE)).toBe(false);
  });
});

/* THE WALL'S PAUSE (mail 0135): the ladder reads `null` as "not paused" and absent as an older API. */
describe("the hosted mapper carries the wall's pause untouched", () => {
  it("a stamp survives, `null` survives, and absent stays undefined", () => {
    const at = "2026-09-23T02:15:07.000Z";
    expect(toMailboxFacts({ ...BARE, organizerParkedAt: at }).organizerParkedAt).toBe(at);
    expect(toMailboxFacts({ ...BARE, organizerParkedAt: null }).organizerParkedAt).toBeNull();
    expect(toMailboxFacts(BARE).organizerParkedAt).toBeUndefined();
  });
});
