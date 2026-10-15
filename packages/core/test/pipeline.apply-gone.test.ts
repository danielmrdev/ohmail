import { describe, it, expect } from "vitest";
import { applyReconcileAction } from "../src/pipeline.js";
import { MessageGoneError } from "../src/adapters/imap.js";
import { FakeRepo, FakeAdapter } from "./fakes.js";
import type { PipelineDeps, FolderStateRow, NativeLocator } from "../src/ports.js";

/**
 * ARM 4 — **THE ORGANIZATION WRITER'S SEAM, WHICH IS WHERE FOUR CONSUMERS MEET.**
 *
 * `applyReconcileAction` is called by the Screener's verdict, by an approval, by the opt-in HEY
 * reroute and by the worker's own runner. Every one of them calls it AFTER a transaction that has
 * already committed the user's decision. `adapter.move` refusing with `MessageGoneError` says the
 * source UID moved or its folder was recycled — see `gone.ts` — and says nothing at all about
 * whether the decision can be carried out.
 *
 * Throwing it therefore did two wrong things at once: it reported a committed decision to the
 * person as a server error, and at the two call sites that LOOP it abandoned every row behind the
 * one that refused.
 *
 * The rule this file pins:
 *
 *  · the refusal does not escape — the caller is not handed an exception for work that is merely
 *    not done yet;
 *  · the DESIRE is persisted, so the row is in the reconciler's queue and the organizer applies it;
 *  · `observedFolder` is NOT advanced — claiming the mail moved is the one thing that must never
 *    happen here;
 *  · the locator is NOT repointed and NO second move is attempted. A read may re-resolve a gone
 *    locator; a mutation may not, because the identity of whatever now wears that UID has not been
 *    proved — which is the whole reason the epoch guard refused in the first place;
 *  · `deferred` is on the return so a caller that counts moves does not count this one;
 *  · anything that is NOT a gone locator still propagates.
 */

function makeDeps(): PipelineDeps & { repo: FakeRepo; adapter: FakeAdapter } {
  return { repo: new FakeRepo(), adapter: new FakeAdapter(), accountId: "acct-1", mailboxId: "mb-1" };
}
const loc = (folder: string, ref = "12:5"): NativeLocator => ({ folder, ref });
const state = (desiredFolder: string, observedFolder: string): FolderStateRow =>
  ({ desiredFolder, observedFolder, lastSetBy: "us" });

/** An adapter whose `move` refuses the way a recycled folder makes the real one refuse. */
function goneAdapter(): FakeAdapter {
  const a = new FakeAdapter();
  a.move = async (l: NativeLocator) => { throw new MessageGoneError(l); };
  return a;
}

describe("applyReconcileAction — a gone source locator is DEFERRED, never thrown", () => {
  it("reports `deferred` and WRITES NOTHING — the caller's committed intent is left alone", async () => {
    const d = makeDeps();
    d.adapter = goneAdapter();
    // The caller's transaction has already committed the decision, which is what all four call
    // sites do. This is that row.
    await d.repo.upsertFolderState("m1", {
      desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us",
    });

    const out = await applyReconcileAction(
      d, { messageId: "m1", locator: loc("INBOX"), state: state("ohmail/News", "INBOX") },
      { type: "move", to: "ohmail/News" },
    );

    expect(out.deferred).toBe(true);
    // THE ROW IS UNTOUCHED AND STILL QUEUED. `desired ≠ observed` is what the reconciler selects
    // on, so this is indistinguishable from a decision taken with no adapter injected — a shape
    // this system already converges every cycle.
    expect(await d.repo.getFolderState("m1"))
      .toEqual({ desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" });
    // AND IT DOES NOT CLAIM THE MAIL MOVED. If `observedFolder` read as the destination the row
    // would look converged, the reconciler would never look again, and the client would paint the
    // message in a folder it is not in.
    expect(out.state.observedFolder).toBe("INBOX");
  });

  /**
   * THE REVIEW FINDING, PINNED. A post-I/O write of a pre-I/O value overwrites a decision taken
   * during the round trip. This arm used to re-assert the desire it was called with, so a newer
   * choice committed by another device while the move was in flight was replaced by the older one
   * — and the reconciler would then carry the mail to the folder the person had changed their mind
   * about. The fix is that the arm writes nothing at all.
   */
  it("does NOT overwrite a decision that landed while the move was in flight", async () => {
    const d = makeDeps();
    let newer: (() => Promise<void>) | null = null;
    d.adapter = new FakeAdapter();
    d.adapter.move = async (l: NativeLocator) => {
      // The competing decision commits DURING the round trip — the window the finding names.
      await newer?.();
      throw new MessageGoneError(l);
    };
    await d.repo.upsertFolderState("m1", {
      desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us",
    });
    newer = async () => {
      await d.repo.upsertFolderState("m1", {
        desiredFolder: "ohmail/Paper Trail", observedFolder: "INBOX", lastSetBy: "us",
      });
    };

    await applyReconcileAction(
      d, { messageId: "m1", locator: loc("INBOX"), state: state("ohmail/News", "INBOX") },
      { type: "move", to: "ohmail/News" },
    );

    // THE NEWER DECISION STANDS. Before the fix this read `ohmail/News` — the older desire,
    // written back after the newer one had committed.
    expect((await d.repo.getFolderState("m1"))?.desiredFolder).toBe("ohmail/Paper Trail");
  });

  it("does NOT retry the move against a re-resolved locator — exactly one attempt, and the locator stands", async () => {
    const d = makeDeps();
    let attempts = 0;
    d.adapter = new FakeAdapter();
    d.adapter.move = async (l: NativeLocator) => { attempts++; throw new MessageGoneError(l); };

    const out = await applyReconcileAction(
      d, { messageId: "m1", locator: loc("INBOX"), state: state("ohmail/News", "INBOX") },
      { type: "move", to: "ohmail/News" },
    );

    // ONE attempt. A mutation that re-resolved and moved again would be doing precisely what the
    // epoch guard exists to stop — acting on a UID whose current occupant is unknown.
    expect(attempts).toBe(1);
    expect(out.locator).toEqual(loc("INBOX"));
  });

  it("records WHY, so a deferred row is not a silent one", async () => {
    const d = makeDeps();
    d.adapter = goneAdapter();
    await applyReconcileAction(
      d, { messageId: "m1", locator: loc("INBOX"), state: state("ohmail/News", "INBOX") },
      { type: "move", to: "ohmail/News" },
    );
    const audit = d.repo.audits[0]!;
    expect(audit.action).toBe("move_deferred");
    expect(audit.payload).toMatchObject({ messageId: "m1", from: "INBOX", to: "ohmail/News" });
    // The reason names the mechanism AND the recovery, because an operator reading this row a week
    // later needs to know the intent was not dropped.
    expect(String((audit.payload as { reason: string }).reason)).toContain("Message-ID");
  });

  it("a refusal that is NOT a gone locator still propagates — this arm narrows one condition, not all of them", async () => {
    const d = makeDeps();
    const boom = new Error("[NO] over quota");
    d.adapter = new FakeAdapter();
    d.adapter.move = async () => { throw boom; };

    await expect(applyReconcileAction(
      d, { messageId: "m1", locator: loc("INBOX"), state: state("ohmail/News", "INBOX") },
      { type: "move", to: "ohmail/News" },
    )).rejects.toBe(boom);
    // Nothing was written on the way out — the same property the gone arm now has, reached by a
    // different route: this function does not write folder state on any failure path.
    expect(await d.repo.getFolderState("m1")).toBeNull();
  });

  it("a move that LANDS is untouched by any of this — `deferred` is absent and the row converges", async () => {
    const d = makeDeps();
    await d.repo.insertMessage({ senderCheck: null,
      accountId: "acct-1", mailboxId: "mb-1",
      canonical: { messageIdHeader: "a@b", bodyHash: "h" },
      dedupKey: "mid:a@b", subject: "", fromAddress: "", date: null,
      nativeLocator: loc("INBOX"),
      flags: { no_ai: false, no_forward: false, no_kb: false, priority: false },
    });
    const id = [...d.repo.rows.keys()][0]!;
    const out = await applyReconcileAction(
      d, { messageId: id, locator: loc("INBOX"), state: state("ohmail/News", "INBOX") },
      { type: "move", to: "ohmail/News" },
    );
    expect(out.deferred).toBeUndefined();
    expect(out.state.observedFolder).toBe("ohmail/News");
  });
});
