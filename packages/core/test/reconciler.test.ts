import { describe, it, expect } from "vitest";
import { reconcile } from "../src/reconciler.js";
import type { FolderStateRow, MoveEvidence } from "../src/ports.js";

const state = (
  desiredFolder: string,
  observedFolder: string,
  lastSetBy: "us" | "external" = "us",
): FolderStateRow => ({ desiredFolder, observedFolder, lastSetBy });

const CORRELATED: MoveEvidence = { kind: "correlated_move" };
const ABSENT: MoveEvidence = { kind: "verified_absence" };
const APPEARANCE: MoveEvidence = { kind: "appearance_only" };

describe("reconcile (desired-vs-observed, user-wins)", () => {
  it("does nothing when reality already matches the desired folder", () => {
    expect(reconcile(state("INBOX", "INBOX"), "INBOX", APPEARANCE)).toEqual({ type: "none" });
  });

  it("moves toward desired when our intended move has not been applied yet", () => {
    expect(reconcile(state("ohmail/News", "INBOX"), "INBOX", APPEARANCE))
      .toEqual({ type: "move", to: "ohmail/News" });
  });

  it("returns none once our own move has landed (observed catches up to desired)", () => {
    expect(reconcile(state("ohmail/News", "INBOX"), "ohmail/News", APPEARANCE))
      .toEqual({ type: "none" });
  });

  it("adopts an external move (user wins) instead of reverting — on a CORRELATED move", () => {
    // We wanted INBOX; the user dragged it to Archive. Reality diverged from our record, AND the
    // adapter paired the vanished INBOX UID with the re-appeared Archive one.
    expect(reconcile(state("INBOX", "INBOX"), "Archive", CORRELATED))
      .toEqual({ type: "adopt_external", newDesired: "Archive" });
  });

  it("adopts on a VERIFIED ABSENCE too — the case `correlateMoves` cannot pair", () => {
    // The second adoptable member, and it is not redundant: a message with no Message-ID at all,
    // or a delete and a create landing in different batches, is a real user move the correlator
    // structurally cannot see. Drop this member and `reconcileFolders` drags the user's move back.
    expect(reconcile(state("INBOX", "INBOX"), "Archive", ABSENT))
      .toEqual({ type: "adopt_external", newDesired: "Archive" });
  });

  it("lets the user win even over a pending automated move", () => {
    // We were mid-move to Feed (observed still INBOX); the user moved it to Archive first.
    expect(reconcile(state("ohmail/News", "INBOX"), "Archive", CORRELATED))
      .toEqual({ type: "adopt_external", newDesired: "Archive" });
  });

  // ── the consent boundary ──────────────────────────────────────────────────────────────────

  it("REFUSES to adopt on an appearance alone", () => {
    // Same folder divergence as the two adoption cases above; the ONLY difference is that nothing
    // disappeared. A stranger can produce this state by delivering a second copy of a message the
    // user already holds, so adopting it hands them the placement of mail the user never consented
    // to. Replace `permitsAdoption(evidence)` with `true` in `reconciler.ts` and this reports
    // `{ type: 'adopt_external', newDesired: 'ohmail/News' }` — which IS the vulnerability.
    expect(reconcile(state("INBOX", "INBOX"), "ohmail/News", APPEARANCE))
      .toEqual({ type: "move", to: "INBOX" });
  });

  it("an appearance in an ohmail folder is no more adoptable than one anywhere else", () => {
    // The caveat that makes folder identity useless as a signal: the user's OWN provider-side
    // sieve rules can deliver straight into `ohmail/*`, so "it showed up in a folder we manage"
    // cannot mean "we put it there" and cannot mean "the user put it there" either.
    for (const folder of ["ohmail/Screened", "ohmail/Receipts", "Archive", "INBOX/Sub"]) {
      expect(reconcile(state("ohmail/Screener", "ohmail/Screener"), folder, APPEARANCE).type)
        .toBe("move");
    }
  });

  it("converged wins over everything — even a real disappearance changes nothing", () => {
    // `observedNow === desired` short-circuits BEFORE the evidence is consulted, so a correlated
    // move INTO the folder we already wanted is `none` and not a redundant adoption.
    expect(reconcile(state("ohmail/News", "INBOX"), "ohmail/News", CORRELATED))
      .toEqual({ type: "none" });
  });
});
