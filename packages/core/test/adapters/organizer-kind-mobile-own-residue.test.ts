/**
 * A PHONE ORGANIZES THROUGH ITS OWN RENEW RESIDUE — the mechanism that used not to, as a pair.
 *
 * ── WHAT WENT WRONG, MEASURED ─────────────────────────────────────────────────────────────
 *
 * `apps/sidecar/test/phone-claim-own.imap.test.ts` drove the phone's composition against a real
 * IMAP server: the install wrote its claim 1.8 s after consent, held it for one poll interval,
 * and at 19 s logged `organizer_stand_down organized_elsewhere:unknown` naming ITS OWN display
 * name — then released its own claim, leaving the folder empty. One install id, one identity
 * source, one claim. It repeated every cycle, so a standalone phone never kept a lease.
 *
 * A renew APPENDS a claim and expunges the older copy afterwards, so for a moment the folder
 * holds two of ours with different nonces. `decideLease`'s rule 1/2 scans the RAW list for a live
 * claim it cannot rank and excludes only `rawOurs` — install id AND the armed nonce — so the
 * older copy is not "ours" there. For a desktop that copy is RANKABLE (`local`) and the election
 * settles it. For a phone it was not: the read set admitted `local` and `cloud` only, so the
 * install's own previous claim parsed as `unknown`, was live, and tripped the arm that no
 * authorization can override. A phone was the one install whose own kind it could not rank.
 *
 * ── WHAT FIXED IT, AND WHAT THIS FILE HOLDS NOW ───────────────────────────────────────────
 *
 * `mobile` is a member of `OrganizerKind`, of the database's `ORGANIZER_KINDS` and of the
 * `mailboxes_organized_by_kind_closed` CHECK, together. So the pair below is a pair of GREENS
 * that differ in nothing: same install, same two nonces, same instants, `local` and `mobile`
 * both organize. The `rawOurs` exclusion is untouched — it is still install id AND nonce, which
 * is the CLONE defence — and the last case is what proves it, because loosening that comparison
 * is the tempting wrong fix and it would admit a restored copy of us as ourselves.
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

const NOW = new Date("2026-09-11T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

const INSTALL = "install-marker-abc";

/**
 * ONE INSTALL'S CLAIM AT A GIVEN NONCE — the renew's shape, which is the whole fixture.
 *
 * `heartbeat` is 5 s old for the renewed copy and 15 s for the residue: one poll interval apart
 * and both far inside the staleness window, which is what makes the residue LIVE. The two differ
 * in nothing but the nonce and the instants, because the defect is about nothing else.
 */
function claimAt(kind: OrganizerKind, nonce: string, ageMs: number): OrganizerClaim {
  return parseClaim(formatClaim({
    authorizedAt: null,
    /* A tenure nobody pressed for describes itself as a takeover, which is what every record
       written before the verb existed says and what those installs do. */
    intent: "takeover",
    capabilities: [],
    installId: INSTALL,
    kind,
    displayName: "the measured phone",
    heartbeat: ago(ageMs),
    claimedAt: ago(120_000),
    nonce,
  })) as OrganizerClaim;
}

/** This install, mid-launch: the nonce the last successful gate armed. */
function self(kind: OrganizerKind, nonce: string): LeaseSelf {
  return { installId: INSTALL, kind, displayName: "the measured phone", lastNonce: nonce };
}

describe("one install, two of its own claims — the renew's own residue", () => {
  it("PREMISE: the residue is live and the fixture is a well-formed pair, not a broken record", () => {
    const renewed = claimAt("mobile", "nonce-new", 5_000);
    const residue = claimAt("mobile", "nonce-old", 15_000);

    // Well-formed: `malformed` and `unknown` take different paths through the gate, and this pair
    // must take the second. A fixture that was merely broken would satisfy the cases below while
    // measuring nothing about the kind.
    expect("malformed" in renewed).toBe(false);
    expect("malformed" in residue).toBe(false);
    expect(renewed.protocol).toBe(CLAIM_PROTOCOL);
    // Both far inside the window — so "live" is a property of the fixture rather than a hope.
    expect(NOW.getTime() - residue.heartbeat.getTime()).toBeLessThan(DEFAULT_STALE_AFTER_MS);
    expect(residue.installId).toBe(renewed.installId);
    expect(residue.nonce).not.toBe(renewed.nonce);
  });

  it("A DESKTOP ORGANIZES THROUGH IT — the pair control, and the reason this is about the kind", () => {
    const verdict = decideLease({
      self: self("local", "nonce-new"),
      claims: [claimAt("local", "nonce-old", 15_000), claimAt("local", "nonce-new", 5_000)],
      now: NOW,
      staleAfterMs: DEFAULT_STALE_AFTER_MS,
    });

    // Same install, same two nonces, same instants — only the kind differs from the case below.
    expect(verdict.verdict).toBe("organize");
  });

  it("A PHONE ORGANIZES THROUGH ITS OWN RESIDUE — the case the fix flipped", () => {
    const verdict = decideLease({
      // `self.kind` is the WRITE kind and the ranking never reads it, so the phone is spelled
      // `mobile` here for honesty rather than for effect. What decides is the KIND IN THE FOLDER.
      self: self("mobile", "nonce-new"),
      claims: [claimAt("mobile", "nonce-old", 15_000), claimAt("mobile", "nonce-new", 5_000)],
      now: NOW,
      staleAfterMs: DEFAULT_STALE_AFTER_MS,
    });

    // Rule 3: we hold the strongest live claim and this is a continuation. Before the read set
    // learned `mobile` this was `stand_down organized_elsewhere:unknown` naming this install's
    // own older claim — a phone handing its mailbox back to itself, every cycle.
    expect(verdict.verdict).toBe("organize");
    if (verdict.verdict !== "organize") return;
    // NOT a takeover: an ordinary renew displaces nothing, so the residue is left for the renew's
    // own expunge rather than swept by an authorized displacement.
    expect(verdict.authorized).toBe(false);
    expect(verdict.displace).toEqual([]);
  });

  it("AND A PRESS IS NOT NEEDED FOR IT — the same answer with and without one", () => {
    // The press arm is where the old defect was permanent: rule 1/2 refused an authorized
    // takeover too, so no action on the phone ended the loop. Both arms now answer `organize`,
    // and this case is here so a fix that only helped the PRESSED path could not pass.
    for (const takeover of [null, { authorizedAt: NOW, intent: "takeover" as const }]) {
      const verdict = decideLease({
        self: self("mobile", "nonce-new"),
        claims: [claimAt("mobile", "nonce-old", 15_000), claimAt("mobile", "nonce-new", 5_000)],
        now: NOW,
        staleAfterMs: DEFAULT_STALE_AFTER_MS,
        ...(takeover === null ? {} : { takeover }),
      });
      expect(verdict.verdict, takeover === null ? "unpressed" : "pressed").toBe("organize");
    }
  });

  it("AND AN AUTHORIZED TAKEOVER DISPLACES THE CLONE'S CLAIM — the expunge half", () => {
    /* THREE PLACES SPELL "ours by id AND nonce" AND THIS CASE MEASURES THE THIRD. `isOurs` keeps
       the clone from winning rule 3 (the case below). `rawOurs` guards rules 1/2, which a `mobile`
       claim can no longer reach at all now that the kind is rankable — `organizer-lease-lone-claim`
       reaches that arm through a protocol and a kind this build cannot place. Rule 6's
       DISPLACEMENT carries its own inline copy of the two terms, and that is what decides here:
       loosened to the id alone it leaves the clone's live claim standing in the folder, the next
       cycle elects the clone on incumbency, and the takeover the person asked for is reversed.
       Measured, one mutation at a time: `rawOurs` loosened leaves every case here green; the
       displacement's own copy loosened reddens exactly this one. */
    const ours = claimAt("mobile", "nonce-ours", 5_000);
    const clone = parseClaim(formatClaim({
      authorizedAt: null,
      capabilities: [],
      installId: INSTALL,
      kind: "mobile",
      displayName: "a restored copy of the measured phone",
      heartbeat: ago(2_000),
      claimedAt: ago(600_000),
      nonce: "nonce-the-clone-wrote",
    }), "clone-ref") as OrganizerClaim;

    const verdict = decideLease({
      self: self("mobile", "nonce-ours"),
      claims: [ours, clone],
      now: NOW,
      staleAfterMs: DEFAULT_STALE_AFTER_MS,
      // A person pressing "Organize here" on this phone. The clone predates it, so this wins.
      takeover: { authorizedAt: NOW, intent: "takeover" },
    });

    expect(verdict.verdict).toBe("organize");
    if (verdict.verdict !== "organize") return;
    expect(verdict.authorized).toBe(true);
    expect(verdict.displace, "the clone's claim was left standing in the folder")
      .toEqual(["clone-ref"]);
  });

  it("AND THE CLONE DEFENCE IS UNTOUCHED — our id at a nonce we never armed is FOREIGN", () => {
    // `isOurs`'s half: restore-from-backup clones the install id, so a LIVE claim bearing our id
    // at a nonce we did not write is another machine running a copy of us. Two organizers moving
    // one person's mail is the invariant the whole lease exists for. Measured: with `isOurs`'s
    // clone term removed this case answers `organize` — the clone is adopted as ourselves.
    const verdict = decideLease({
      self: self("mobile", "nonce-ours"),
      // Newer heartbeat than anything of ours, our id, a nonce this process never armed.
      claims: [claimAt("mobile", "nonce-the-clone-wrote", 1_000)],
      now: NOW,
      staleAfterMs: DEFAULT_STALE_AFTER_MS,
    });

    expect(verdict.verdict).toBe("stand_down");
    if (verdict.verdict !== "stand_down") return;
    // Ranked, not refused-as-unrankable: `mobile` is a kind now, so the clone loses the election
    // rather than tripping rule 1/2. The reason names a phone, which is what it is.
    expect(verdict.reason).toBe("organized_elsewhere:mobile");
    expect(verdict.by?.nonce).toBe("nonce-the-clone-wrote");
  });
});
