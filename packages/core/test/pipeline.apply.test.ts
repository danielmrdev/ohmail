import { describe, it, expect } from "vitest";
import { applyReconcileAction } from "../src/pipeline.js";
import { FakeRepo, FakeAdapter } from "./fakes.js";
import type { PipelineDeps, FolderStateRow, NativeLocator } from "../src/ports.js";

function makeDeps(): PipelineDeps & { repo: FakeRepo; adapter: FakeAdapter } {
  return { repo: new FakeRepo(), adapter: new FakeAdapter(), accountId: "acct-1", mailboxId: "mb-1" };
}
const loc = (folder: string, ref = "1:5"): NativeLocator => ({ folder, ref });
const state = (
  desiredFolder: string,
  observedFolder: string,
  lastSetBy: "us" | "external" = "us",
): FolderStateRow => ({ desiredFolder, observedFolder, lastSetBy });

describe("applyReconcileAction", () => {
  it("'none' converges observed to desired without touching the adapter", async () => {
    const d = makeDeps();
    const out = await applyReconcileAction(
      d, { messageId: "m1", locator: loc("INBOX"), state: state("INBOX", "INBOX") }, { type: "none" },
    );
    expect(d.adapter.moves).toEqual([]);
    expect(out.state).toEqual({ desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
    expect(await d.repo.getFolderState("m1"))
      .toEqual({ desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
  });

  it("'none' preserves a user-owned (external) folder state", async () => {
    const d = makeDeps();
    const out = await applyReconcileAction(
      d, { messageId: "m1", locator: loc("Archive"), state: state("Archive", "Archive", "external") }, { type: "none" },
    );
    expect(out.state.lastSetBy).toBe("external");
  });

  it("'move' calls the adapter, updates the locator, and records a reversible audit", async () => {
    const d = makeDeps();
    await d.repo.insertMessage({ senderCheck: null,
      accountId: "acct-1", mailboxId: "mb-1",
      canonical: { messageIdHeader: "a@b", bodyHash: "h" },
      dedupKey: "mid:a@b", subject: "", fromAddress: "", date: null,
      nativeLocator: loc("INBOX"),
      flags: { no_ai: false, no_forward: false, no_kb: false, priority: false },
    });
    const id = [...d.repo.rows.keys()][0];
    const out = await applyReconcileAction(
      d, { messageId: id, locator: loc("INBOX"), state: state("ohmail/News", "INBOX") },
      { type: "move", to: "ohmail/News" },
    );
    expect(d.adapter.moves).toEqual([{ from: loc("INBOX"), to: "ohmail/News" }]);
    expect(out.locator.folder).toBe("ohmail/News");
    expect(out.state).toEqual({ desiredFolder: "ohmail/News", observedFolder: "ohmail/News", lastSetBy: "us" });
    expect((await d.repo.getFolderState(id))?.observedFolder).toBe("ohmail/News");
    expect(d.repo.rows.get(id)?.stored.nativeLocator.folder).toBe("ohmail/News");
    const audit = d.repo.audits[0];
    expect(audit.action).toBe("move");
    expect(audit.payload).toEqual({ messageId: id, from: "INBOX", to: "ohmail/News" });
    expect(audit.inverse).toEqual({ messageId: id, from: "ohmail/News", to: "INBOX" });
  });

  // No `adopt_external` case: the writer admits none (`reconcile-writer-adopts-nothing.test.ts`);
  // the adoption's audit is the arrival seam's (`pipeline.test.ts`).
});
