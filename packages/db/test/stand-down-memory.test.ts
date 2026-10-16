import { describe, expect, it } from "vitest";
import { standDownMemory } from "@trafficflow/db";

/**
 * `standDownMemory` — the ONE derivation of "this row remembers standing down, and to whom".
 *
 * It exists because mail 0083 moved that fact from `status='disabled'` + `disabled_reason` onto
 * `organizer_role` + `organized_by_kind` and left the old column with no writer, after which five
 * call sites across the sidecar, the worker's service tier and Cloud all began answering NULL
 * without failing. The consequences are held by tests beside each of those sites; what is held
 * HERE is the shape of the answer, and in particular the ORDER of the two arms, which is the one
 * part a reader is likely to reverse.
 *
 * TO WATCH IT FAIL: swap the two arms in `organizer-role.ts` — ask the role before the status —
 * and the tombstone case goes red, reporting a stand-down on a mailbox the user removed. Run.
 *
 * The other mutation available here does NOT redden, and saying so is the point: dropping the
 * `isMailboxDisabledReason` check on the composed string leaves all six green, because
 * `isOrganizerKind` has already narrowed the kind to the same closed three. That line is a guard
 * for the day the two sets stop being equal, not a live one — its own comment says so, and this
 * note is here so nobody reads the unrecognised-kind case below as covering it.
 */
describe("standDownMemory", () => {
  const CONSENTED = new Date("2026-08-01T00:00:00.000Z");
  const row = (o: Partial<Parameters<typeof standDownMemory>[0]>) => ({
    status: "connected", organizerRole: "organizer", organizedByKind: null,
    organizeConsentedAt: CONSENTED, disabledReason: null,
    // Mail 0088. The lease's occupancy as the row last recorded it, and the RELEASE MARKER — the
    // two fields the live arm reads beside the three above. Both default to "nothing happened",
    // which is what every row in this file is about unless it says otherwise.
    organizerState: null, organizerReleasedAt: null,
    ...o,
  });

  it("a READER remembers, and names the kind that took it — the shape 0083 writes", () => {
    expect(standDownMemory(row({ organizerRole: "reader", organizedByKind: "cloud" })))
      .toBe("organized_elsewhere:cloud");
    expect(standDownMemory(row({ organizerRole: "reader", organizedByKind: "local" })))
      .toBe("organized_elsewhere:local");
  });

  it("a reader whose first cycle has not looked yet still remembers, as `unknown`", () => {
    // The gap between the demotion and the holder columns being filled is exactly when a relaunch
    // would auto-resume if this returned null. "Somebody has it and we do not yet know who" is a
    // stand-down; "nobody has it" is not, and they must not collapse.
    expect(standDownMemory(row({ organizerRole: "reader", organizedByKind: null })))
      .toBe("organized_elsewhere:unknown");
    expect(standDownMemory(row({ organizerRole: "reader", organizedByKind: "a-fourth-kind" })))
      .toBe("organized_elsewhere:unknown");
  });

  it("a PRE-CONSENT reader remembers nothing — `reader` is that state too", () => {
    /* `POST /mailboxes` creates exactly this row so a fresh Cloud connect mirrors and moves
     * nothing: role `reader`, no holder, no consent. Reading the ROLE alone called it a
     * stand-down, so the first press of "organize here" told the person they had taken the
     * mailbox back from another organizer — on a mailbox nobody had ever organized. It is the
     * contract `MailboxTakeoverResult.previousReason` states, and `schema-mail.ts` names consent
     * as the only thing that separates the two reader states.
     *
     * Found by review, not by this file: every case here passed while the defect was live. */
    expect(standDownMemory(row({
      organizerRole: "reader", organizedByKind: null, organizeConsentedAt: null,
    })), "a mailbox nobody has been asked to organize reported another organizer").toBeNull();
  });

  it("…but EITHER a holder OR a consent means somebody was organizing it", () => {
    // The two terms are not redundant. A stand-down writes `organized_by_kind` in the same
    // statement as the role and writes NO consent, so a desktop row whose consent predates the
    // stamp `ensureLocalWorld` sets is a genuine stand-down with consent NULL — and a
    // consent-only test would read it as "never asked" and let the install auto-resume.
    expect(standDownMemory(row({
      organizerRole: "reader", organizedByKind: "local", organizeConsentedAt: null,
    })), "a demoted row with a holder but no consent was read as untouched")
      .toBe("organized_elsewhere:local");
    // And the mirror case: consented, demoted, first cycle has not looked yet.
    expect(standDownMemory(row({
      organizerRole: "reader", organizedByKind: null, organizeConsentedAt: CONSENTED,
    }))).toBe("organized_elsewhere:unknown");
  });

  it("an ORGANIZER remembers nothing, whatever else the row carries", () => {
    expect(standDownMemory(row({}))).toBeNull();
    // A stale holder column on an organizing row is not a stand-down. The promotion clears these
    // four, and a failure to clear them must not read as a demotion on the next launch.
    expect(standDownMemory(row({ organizedByKind: "cloud" }))).toBeNull();
  });

  it("a TOMBSTONE remembers nothing — and this is why `status` is asked FIRST", () => {
    // A removal demotes nothing; it retires the row, which keeps whatever role it had. Asking the
    // role first would report a stand-down that nobody performed, on a mailbox the person deleted
    // — and `ensureLocalWorld` would then decline to mint a fresh row for a re-added address.
    expect(standDownMemory({
      status: "disabled", organizerRole: "reader", organizedByKind: "cloud",
      organizeConsentedAt: CONSENTED, disabledReason: null,
      organizerState: "held", organizerReleasedAt: null,
    })).toBeNull();
    expect(standDownMemory({
      status: "disabled", organizerRole: "organizer", organizedByKind: null,
      organizeConsentedAt: CONSENTED, disabledReason: null,
      organizerState: null, organizerReleasedAt: null,
    })).toBeNull();
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  A RELEASE IS NOT A STAND-DOWN (mail 0088) — and the marker is why it is distinguishable
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * "Stop organizing this mailbox here, keep my mail" leaves a reader with its consent intact and
   * no holder — the same three columns a stand-down leaves once the install that won has gone
   * away. Two things turn on telling them apart, and only one of them is a sentence:
   *
   *  · the claim-back reports what it took the mailbox back FROM, and a release took it from
   *    nobody;
   *  · the standalone launch catch-up closes orphaned scheduled sends on a row that remembers
   *    standing down, and a released install has already closed its own.
   *
   * The discriminator is a MARKER only the release writes. It was first an ABSENCE — no holder, no
   * occupancy — and a review round showed that absence is not exact: the reader's own per-cycle
   * peek writes those columns NULL whenever it finds an empty folder, so a genuine stand-down
   * DECAYS into the released shape one poll after its winner disappears.
   */
  it("a RELEASED reader remembers nothing — nobody took the mailbox", () => {
    expect(standDownMemory(row({
      organizerRole: "reader", organizedByKind: null, organizerState: null,
      organizerReleasedAt: new Date("2026-09-03T10:00:00.000Z"),
    }))).toBeNull();
  });

  it("…and the SAME shape without the marker is a stand-down whose winner went away", () => {
    // The exact row the peek leaves behind, and the reason the marker exists rather than the
    // absence: this must still remember, or the claim-back says nothing and the launch catch-up
    // stops closing appointments it owes an ending.
    expect(standDownMemory(row({
      organizerRole: "reader", organizedByKind: null, organizerState: null,
      organizerReleasedAt: null,
    }))).toBe("organized_elsewhere:unknown");
  });

  it("an ABSENT marker reads as NOT released — the safe direction for an untyped caller", () => {
    /* The field is required by the type, so typed code cannot omit it. This function is reachable
       from code that is not typechecked, and a caller that selected the row without the column
       hands it `undefined` — which must read as "not released", keeping the memory. The inverse
       would erase the memory for every row it is asked about, which is this arm's own failure
       mode inverted. */
    const partial = { ...row({ organizerRole: "reader", organizedByKind: "cloud" }) } as
      Parameters<typeof standDownMemory>[0] & { organizerReleasedAt?: Date | null };
    delete partial.organizerReleasedAt;
    expect(standDownMemory(partial)).toBe("organized_elsewhere:cloud");
  });

  it("a PRE-0083 row still answers from the column it carries", () => {
    // 0083's backfill deliberately left `disabled` any row whose address already had a live
    // sibling, and an older binary can still write this shape mid-deploy. `disabled` + a reason is
    // a PAUSE, and the memory has to survive it or such an install auto-resumes.
    expect(standDownMemory({
      status: "disabled", organizerRole: "organizer", organizeConsentedAt: CONSENTED,
      organizedByKind: null, disabledReason: "organized_elsewhere:local",
    })).toBe("organized_elsewhere:local");
  });

  it("a value outside the closed set is not passed through", () => {
    // The return type is the closed set `STAND_DOWN_SEND_SENTENCES` is keyed by, so anything else
    // would put `undefined` into the sentence a person reads about their unsent message.
    expect(standDownMemory({
      status: "disabled", organizerRole: "organizer", organizeConsentedAt: CONSENTED,
      organizedByKind: null, disabledReason: "something-else",
    })).toBeNull();
  });
});
