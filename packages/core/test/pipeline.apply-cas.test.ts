import { describe, it, expect } from "vitest";
import { applyReconcileAction } from "../src/pipeline.js";
import { FakeRepo, FakeAdapter } from "./fakes.js";
import type { FolderStateRow, NativeLocator } from "../src/ports.js";

/**
 * A DECISION THAT COMMITS WHILE THE MOVE IS IN FLIGHT SURVIVES THE COMPLETION
 * (a completion that overwrote a newer intent).
 *
 * The success arm used to write `desired = observed = action.to` through `upsertFolderState` —
 * a post-I/O write of a pre-I/O value. `desired_folder` has six writers that take no mailbox row,
 * so a re-decision landing during the round trip was reverted with nothing erroring and the mail
 * ended where the older decision said.
 *
 * The newer desire is committed FROM INSIDE `adapter.move` (`FakeAdapter.onMove`), which is the
 * only window that reaches this arm: a fixture that wrote it before the call would be testing the
 * reconcile decision instead. The interleave itself is proven against real Postgres, two sessions,
 * in `apps/worker/test/pipeline-move-cas.pg.test.ts` — this file pins the arm's bookkeeping.
 */
const loc = (folder: string, ref = "1:5"): NativeLocator => ({ folder, ref });
const state = (desiredFolder: string, observedFolder: string): FolderStateRow =>
  ({ desiredFolder, observedFolder, lastSetBy: "us" });

const SOURCE = "ohmail/News";
const OLD = "INBOX";
const NEWER = "ohmail/Screener";

function makeDeps() {
  return { repo: new FakeRepo(), adapter: new FakeAdapter(), accountId: "acct-1", mailboxId: "mb-1" };
}

describe("applyReconcileAction — the landed move records a fact, never a desire", () => {
  it("a desire committed during the move STANDS, and the landed folder is still recorded", async () => {
    const d = makeDeps();
    await d.repo.upsertFolderState("m1", state(OLD, SOURCE));
    // The competing writer: another door commits `NEWER` while the IMAP move is in flight.
    d.adapter.onMove = () => { void d.repo.upsertFolderState("m1", state(NEWER, SOURCE)); };

    const out = await applyReconcileAction(
      d, { messageId: "m1", locator: loc(SOURCE), state: state(OLD, SOURCE) },
      { type: "move", to: OLD },
    );

    const row = await d.repo.getFolderState("m1");
    expect(row?.desiredFolder).toBe(NEWER);        // the newer decision was NOT overwritten
    expect(row?.observedFolder).toBe(OLD);         // the physical fact IS recorded
    expect(out.state.desiredFolder).toBe(NEWER);   // the caller is told what stands
    expect(d.repo.audits.map((a) => a.action)).toEqual(["move", "move_superseded"]);
    // The locator is repointed either way: the server moved the mail, and the next cycle files
    // from where it actually is toward the newer desire.
    expect(out.locator.folder).toBe(OLD);
  });

  it("POSITIVE CONTROL — an ordinary move converges the pair and records no supersede", async () => {
    const d = makeDeps();
    await d.repo.upsertFolderState("m1", state(OLD, SOURCE));

    const out = await applyReconcileAction(
      d, { messageId: "m1", locator: loc(SOURCE), state: state(OLD, SOURCE) },
      { type: "move", to: OLD },
    );

    expect(await d.repo.getFolderState("m1"))
      .toEqual({ desiredFolder: OLD, observedFolder: OLD, lastSetBy: "us" });
    expect(out.state).toEqual({ desiredFolder: OLD, observedFolder: OLD, lastSetBy: "us" });
    expect(d.repo.audits.map((a) => a.action)).toEqual(["move"]);
  });

  it("no row at all is the OTHER meaning of a declined completion, and it is created", async () => {
    const d = makeDeps();
    const out = await applyReconcileAction(
      d, { messageId: "m1", locator: loc(SOURCE), state: state(OLD, SOURCE) },
      { type: "move", to: OLD },
    );
    expect(await d.repo.getFolderState("m1"))
      .toEqual({ desiredFolder: OLD, observedFolder: OLD, lastSetBy: "us" });
    expect(out.state.desiredFolder).toBe(OLD);
    expect(d.repo.audits.map((a) => a.action)).toEqual(["move"]);
  });
});
