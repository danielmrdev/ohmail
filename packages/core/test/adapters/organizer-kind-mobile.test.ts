/**
 * A PHONE SAYS `mobile` AND EVERY READER RANKS IT — both halves, in one file.
 *
 * A standalone phone stamps `X-Ohmail-Organizer-Kind: mobile` into the claim it writes to
 * `ohmail/_meta`. The reader half — this module's parse arm, the database's closed
 * `ORGANIZER_KINDS`, the `mailboxes_organized_by_kind_closed` CHECK and the migration behind them
 * — shipped one release later, and that gap is what this file used to pin.
 *
 * ── WHAT THE GAP COST, SO NOBODY REOPENS IT ───────────────────────────────────────────────
 *
 * A kind written but not admitted parses as `unknown`, which rules 1/2 read as a live claim by a
 * peer this build cannot rank: stand down, and no authorization overrides it. That was survivable
 * for a desktop looking at somebody's phone and fatal for the phone itself — a renew appends
 * before it expunges, so the phone met its OWN older claim as an unrankable live peer and handed
 * its mailbox back to itself every cycle (`organizer-kind-mobile-own-residue.test.ts` is the
 * mechanism). Widening the parse arm alone would have been the other half-fix: a reader would
 * write `organized_elsewhere:mobile` into a column whose CHECK refused the value, and the write
 * would fail on a mailbox somebody is using. One set, everywhere, in one slice.
 */
import { describe, expect, it } from "vitest";

import {
  CLAIM_PROTOCOL,
  DEFAULT_STALE_AFTER_MS,
  decideLease,
  formatClaim,
  parseClaim,
  type LeaseSelf,
  type OrganizerClaim,
  type OrganizerKind,
} from "@trafficflow/core/adapters/organizer-lease";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/**
 * A REAL PRESS, and it is spelled as an object for a reason worth recording.
 *
 * `takeover` is `{ authorizedAt: Date }`. Written as the string `"authorized"` — which is how the
 * neighbouring suite's local helper spells its own third ARGUMENT — it is silently not an
 * authorization at all, and this package does not typecheck its tests, so nothing says so. The
 * refusal case below then passes for the wrong reason: it refuses a press that was never made.
 * Caught here only because the last case is a POSITIVE control that requires a press to WORK, and
 * it failed. Both cases share this constant so they cannot drift apart again.
 */
/* The phone's own press, as this file has always modelled it: an explicit ask for THIS install.
   `takeover` keeps every row here measuring the kind question it was written for; the verb's own
   arm is in the decision table. */
const PRESSED = { authorizedAt: NOW, intent: "takeover" } as const;

/** The claim a standalone phone writes. `kind: "mobile"` is the whole point of the fixture. */
function phoneClaimRaw(): string {
  return formatClaim({
    authorizedAt: null,
    /* A tenure nobody pressed for describes itself as a takeover, which is what every record
       written before the verb existed says and what those installs do. */
    intent: "takeover",
    capabilities: [],
    installId: "phone-install",
    kind: "mobile",
    displayName: "Pixel 9",
    heartbeat: ago(5_000),
    claimedAt: ago(120_000),
    nonce: "n-phone",
  });
}

/** The same claim, left un-renewed for longer than the staleness window. */
function stalePhoneClaim(): OrganizerClaim {
  return parseClaim(
    formatClaim({
      authorizedAt: null,
      capabilities: [],
      installId: "phone-install",
      kind: "mobile",
      displayName: "Pixel 9",
      heartbeat: ago(DEFAULT_STALE_AFTER_MS + 60_000),
      claimedAt: ago(DEFAULT_STALE_AFTER_MS + 120_000),
      nonce: "n-phone",
    }),
  ) as OrganizerClaim;
}

describe("a phone's claim, written by this build and read by this build", () => {
  it("writes `mobile` into the record's kind header", () => {
    // THE POSITIVE CONTROL. Without it this file would prove only that something is refused, and
    // a writer that could not spell `mobile` at all would satisfy every other case here while
    // making the standalone phone unable to claim its own mailbox.
    const raw = phoneClaimRaw();
    expect(raw).toContain("X-Ohmail-Organizer-Kind: mobile");
  });

  it("reads that record back as a claim by an install it CAN rank", () => {
    const parsed = parseClaim(phoneClaimRaw()) as OrganizerClaim;

    // Everything else round-trips — this is a well-formed claim, not a broken one. That matters:
    // `malformed` and `unknown` take different paths through the gate, and a phone's claim must
    // take the second.
    expect(parsed).toMatchObject({
      installId: "phone-install",
      displayName: "Pixel 9",
      protocol: CLAIM_PROTOCOL,
      nonce: "n-phone",
    });
    expect("malformed" in parsed).toBe(false);

    // RANKED, not `unknown`: this is the line the whole slice turns on.
    expect(parsed.kind).toBe("mobile");
  });

  it("stands down from a live phone claim rather than organizing beside it", () => {
    const self: LeaseSelf = {
      installId: "this-desktop",
      kind: "local",
      displayName: "This Mac",
      lastNonce: null,
    };
    const claim = parseClaim(phoneClaimRaw()) as OrganizerClaim;

    const verdict = decideLease({ self, claims: [claim], now: NOW, staleAfterMs: DEFAULT_STALE_AFTER_MS });

    expect(verdict.verdict).toBe("stand_down");
    // It stands down for the ORDINARY reason now — it lost the election to a live incumbent — and
    // the reason NAMES A PHONE, which is what `standDown_organized_elsewhere_mobile` renders.
    // `:unknown` here would put "another ohmail organizer" over a mailbox whose holder is known.
    expect(verdict).toMatchObject({ reason: "organized_elsewhere:mobile" });
  });

  it("TAKES the mailbox from a live phone on a press, and DISPLACES its claim", () => {
    const self: LeaseSelf = {
      installId: "this-desktop",
      kind: "local",
      displayName: "This Mac",
      lastNonce: null,
    };
    // The claim carries the IO's own handle, because the displacement set is built from `ref` and
    // a fixture without one reports an EMPTY set over a claim it did displace — a green that says
    // nothing about the expunge.
    const claim = parseClaim(phoneClaimRaw(), "phone-claim-ref") as OrganizerClaim;

    // The ruling's own sequence: a desktop or Cloud takes over from a phone with a press, and the
    // phone becomes a reader on its next open. This case ANSWERED `stand_down` while the kind was
    // unrankable — a press that did nothing, for ever — and that is why the mailbox pane's
    // `blocked_organized_elsewhere_mobile` may promise the control that moves the organizing here.
    const verdict = decideLease({
      self,
      claims: [claim],
      now: NOW,
      staleAfterMs: DEFAULT_STALE_AFTER_MS,
      takeover: PRESSED,
    });

    expect(verdict.verdict).toBe("organize");
    if (verdict.verdict !== "organize") return;
    // A takeover that does not change the FOLDER is undone one cycle later on incumbency, so the
    // phone's claim has to be in the displacement set rather than merely out-ranked.
    expect(verdict.authorized).toBe(true);
    expect(verdict.displace).toEqual(["phone-claim-ref"]);
  });

  it("and WITHOUT a press it leaves the live phone alone — the other half of that pair", () => {
    // The half that makes the case above a takeover rather than a build that lets anybody in: the
    // identical fixture with no press stands down. Both arms, or "it organizes" proves nothing
    // about what a person asked for.
    const self: LeaseSelf = {
      installId: "this-desktop",
      kind: "local",
      displayName: "This Mac",
      lastNonce: null,
    };
    expect(decideLease({
      self,
      claims: [parseClaim(phoneClaimRaw()) as OrganizerClaim],
      now: NOW,
      staleAfterMs: DEFAULT_STALE_AFTER_MS,
      takeover: null,
    }).verdict).toBe("stand_down");
  });

  it("A PHONE MEETING A DESKTOP'S LIVE CLAIM STANDS DOWN, unchanged by this slice", () => {
    // The direction the phone ruling names: the phone loses to a live host on incumbency and
    // becomes a reader with its mirror intact. Asserted here because widening the READ set is
    // exactly the change that could have started letting a phone organize beside a desktop.
    const self: LeaseSelf = {
      installId: "phone-install",
      kind: "mobile",
      displayName: "Pixel 9",
      lastNonce: null,
    };
    const desktop = parseClaim(
      formatClaim({
        authorizedAt: null,
        capabilities: [],
        installId: "this-desktop",
        kind: "local",
        displayName: "This Mac",
        heartbeat: ago(5_000),
        claimedAt: ago(120_000),
        nonce: "n-desktop",
      }),
    ) as OrganizerClaim;

    const verdict = decideLease({
      self, claims: [desktop], now: NOW, staleAfterMs: DEFAULT_STALE_AFTER_MS,
    });
    expect(verdict.verdict).toBe("stand_down");
    if (verdict.verdict !== "stand_down") return;
    expect(verdict.reason).toBe("organized_elsewhere:local");
  });

  /**
   * ── MEASURED DEFECT, PRE-EXISTING, AND THIS LANE IS WHAT MAKES IT REACHABLE ───────────────
   *
   * A press is refused even after the phone's claim has been stale for a week, and it stays
   * refused for ever. That is NOT what the binding ruling says: §1.4 states a build that cannot
   * rank `mobile` "cannot take a mailbox from a LIVE Android phone by pressing until the claim is
   * stale or released". The first half holds. The second does not.
   *
   * THE MECHANISM, read rather than guessed. Arm 1/2 of `decideLease` refuses an unrankable claim
   * that is `rawIsLive`, before any authorization is considered ("no authorization overrides
   * them"). `rawIsLive` is FOLDER-RELATIVE — `newestHeartbeat - clamped < staleAfterMs` — so with
   * one claim in `ohmail/_meta` the newest heartbeat IS that claim's own, the difference is zero,
   * and the claim is live however old it is in wall-clock terms. The `quiet` escape that lets a
   * stale CLOUD claim be taken (arm 8) is computed against `now` and would answer correctly here,
   * but arm 1/2 returns before it is reached.
   *
   * It is the same failure this file's own module already names and fixed one function over: the
   * comment on `quiet` says reading a lone implausible claim as busy "let one dead machine hold a
   * mailbox for seventy-three years with no way out short of a person deleting the message by
   * hand". That fix landed on `quiet` and not on the arm beside it.
   *
   * WHO IT HURTS AND HOW, today, with no phone involved: any claim carrying a protocol this build
   * does not know is unrankable by the same arm and equally permanent. With this lane it acquires
   * an ordinary user path — a person whose phone is lost, broken or wiped cannot press "organize
   * here" on a desktop that predates the protocol slice, and no amount of waiting helps. The
   * routes back are the phone RELEASING its claim (the protocol slice's background and stop paths,
   * which is the designed path), deleting the record by hand, or upgrading the desktop.
   *
   * ── CLOSED ON THE TREE THIS LANDS ON, and the case is now the ruling's own assertion ──────
   *
   * The block above was written when the lane could not fix it: the remedy was one clause in the
   * shared decision table, which the lane was not allowed to touch. The trunk has since rewritten
   * that table's clock and meta-read handling, and both halves now answer the way §1.4 says. So
   * this case stops pinning the defect and pins the behaviour, in both directions — because the
   * press half alone would pass against a build that had made every stale claim takeable by
   * anybody, which is a different and worse answer.
   *
   * Measured at the landing tip, not predicted: pressed gives
   * `{ verdict: "organize", renew: true, authorized: true }`, and UNPRESSED gives `available`
   * with the phone named as the holder it could not rank. The paragraphs above are kept as the
   * history of what the arm used to do and why it mattered, which is the reason to keep a case
   * here at all rather than delete it with the defect.
   */
  it("yields to a press once the phone's claim has gone stale — the ruling's §1.4", () => {
    const self: LeaseSelf = {
      installId: "this-desktop",
      kind: "local",
      displayName: "This Mac",
      lastNonce: null,
    };

    expect(decideLease({ self, claims: [stalePhoneClaim()], now: NOW, staleAfterMs: DEFAULT_STALE_AFTER_MS, takeover: PRESSED }))
      .toMatchObject({ verdict: "organize", authorized: true });
  });

  it("and reports the mailbox available with NO press, rather than held for ever", () => {
    // The other direction, and the half that says the fix is the right one: a stale unrankable
    // claim used to read as live for ever, so an ordinary launch was refused with no way out. It
    // now reports the mailbox as available and NAMES the holder it could not rank, which is what
    // lets a person see whose claim they would be displacing.
    const self: LeaseSelf = {
      installId: "this-desktop",
      kind: "local",
      displayName: "This Mac",
      lastNonce: null,
    };

    const verdict = decideLease({
      self, claims: [stalePhoneClaim()], now: NOW,
      staleAfterMs: DEFAULT_STALE_AFTER_MS, takeover: null,
    });
    expect(verdict).toMatchObject({ verdict: "available" });
    // `mobile`, and this line is the asymmetry closing: the holder a person is offered the mailbox
    // against is named as the phone it is, not as an organizer this build could not read.
    expect(verdict).toMatchObject({ by: { installId: "phone-install", kind: "mobile" } });
  });

  /**
   * THE SAME ANSWER FOR A CLOUD HOLDER — the pair, and its meaning MOVED with mail 0103.
   *
   * It used to be the discriminator: `cloud` was rankable and `mobile` was not, so the same
   * fixture organizing here and refusing above proved the permanence was a property of the
   * unrankable arm. Both kinds are rankable now, so it is no longer a discriminator and this
   * comment says so rather than leaving a reader to believe the old claim. What it still holds is
   * PARITY: a phone's stale claim and a Cloud's yield to a press identically, so the widening
   * gave `mobile` the kinds' shared answer instead of an arm of its own.
   */
  it("answers a cloud holder's stale claim identically — parity, not a discriminator", () => {
    const self: LeaseSelf = {
      installId: "this-desktop",
      kind: "local",
      displayName: "This Mac",
      lastNonce: null,
    };
    const stale = parseClaim(
      formatClaim({
        authorizedAt: null,
        capabilities: [],
        installId: "cloud-install",
        kind: "cloud",
        displayName: "ohmail Cloud",
        heartbeat: ago(DEFAULT_STALE_AFTER_MS + 60_000),
        claimedAt: ago(DEFAULT_STALE_AFTER_MS + 120_000),
        nonce: "n-cloud",
      }),
    ) as OrganizerClaim;

    expect(
      decideLease({ self, claims: [stale], now: NOW, staleAfterMs: DEFAULT_STALE_AFTER_MS, takeover: PRESSED }).verdict,
    ).toBe("organize");
  });

  /**
   * ── THE WORD A DEVICE RIG WROTE, AND WHY THE READING WAS RIGHT ────────────────────────────
   *
   * Device run 6 filed `PHONE-A-DESKTOP-HOLDER-STANDS-DOWN-AS-unknown`: a laptop's claim stood the
   * phone down as `organized_elsewhere:unknown` where a phone's gave `organized_elsewhere:mobile`.
   * The rig's claim carried `X-Ohmail-Organizer-Kind: desktop`, and no build writes that word — a
   * desktop install claims as `local` (`organizerKind ?? "local"`, the sidecar's composition). So
   * the stand-down record DOES carry the kind the claim had; `desktop` is simply not one of the
   * three, and an unrankable live claim stands this install down with nothing able to override it.
   *
   * Both arms in one case: either alone is green against a build that answered `unknown` for
   * everything, and the `local` arm alone is green against one that ignored the header entirely.
   */
  it("carries a DESKTOP claim's kind into the stand-down, and only a word outside the set is `unknown`", () => {
    const self: LeaseSelf = {
      installId: "phone-install",
      kind: "mobile",
      displayName: "Pixel 9",
      lastNonce: null,
    };
    /* The cast is the fixture's whole point and not a convenience: `formatClaim` takes the closed
       three, so only code that does not typecheck can write a fourth word — which is how the rig
       wrote one. */
    const laptop = (kind: string): OrganizerClaim => parseClaim(
      formatClaim({
        authorizedAt: null,
        intent: "takeover",
        capabilities: [],
        installId: "the-laptop",
        kind: kind as OrganizerKind,
        displayName: "a laptop",
        heartbeat: ago(5_000),
        claimedAt: ago(120_000),
        nonce: "n-laptop",
      }),
    ) as OrganizerClaim;
    const standDown = (c: OrganizerClaim): string => {
      const v = decideLease({ self, claims: [c], now: NOW, staleAfterMs: DEFAULT_STALE_AFTER_MS });
      return v.verdict === "stand_down" ? v.reason : v.verdict;
    };

    // WHAT A DESKTOP ACTUALLY WRITES, and what the phone's sentence is built from: `holderKind`
    // reads the suffix, so `local` is the computer arm and never the one for a holder this build
    // could not read.
    expect(laptop("local").kind).toBe("local");
    expect(standDown(laptop("local"))).toBe("organized_elsewhere:local");

    // AND THE WORD THE RIG WROTE. `unknown` survives for a record this build cannot rank, which is
    // the fail-closed direction and is unchanged by anything here.
    expect(laptop("desktop").kind).toBe("unknown");
    expect(standDown(laptop("desktop"))).toBe("organized_elsewhere:unknown");
  });
});
