import { describe, it, expect } from "vitest";
import { applyReconcileAction } from "../src/pipeline.js";
import { FakeRepo, FakeAdapter, FakeRouting } from "./fakes.js";
import type { ExternalOverrideInput } from "../src/ports.js";

/**
 * THE RECONCILE WRITER ADOPTS NOTHING. Its adoption arm recorded the person's hand without the
 * override and had no caller: every caller passes our own `move`. The type admits no adoption,
 * and a value that slips past it is refused rather than adopted unseen (gap row
 * RECONCILE-RUNNER-ADOPT-DOES-NOT-FEED-THE-OVERRIDE). The arrival seam is the one that adopts.
 */
const deps = () => {
  const asked: ExternalOverrideInput[] = [];
  const routing = Object.assign(new FakeRouting(), {
    recordExternalOverride: async (i: ExternalOverrideInput) => { asked.push(i); return null; },
  });
  return { asked, d: { repo: new FakeRepo(), adapter: new FakeAdapter(), accountId: "acct-1", mailboxId: "mb-1", routing } };
};
const ctx = { messageId: "m1", locator: { folder: "INBOX", ref: "1:5" }, state: { desiredFolder: "ohmail/News", observedFolder: "ohmail/News", lastSetBy: "us" as const } };

describe("row 62: no adoption bypasses the override", () => {
  it("an adoption handed to the reconcile writer is refused, and writes nothing", async () => {
    const { asked, d } = deps();
    await expect(applyReconcileAction(d, ctx, { type: "adopt_external", newDesired: "INBOX" } as never))
      .rejects.toThrow(/unreachable reconcile action/);
    expect(asked).toEqual([]);
    expect(d.repo.audits).toEqual([]);
    expect(await d.repo.getFolderState("m1")).toBeNull();
  });

  it("CONTROL: the writer still carries our own move", async () => {
    const { d } = deps();
    const out = await applyReconcileAction(d, { ...ctx, locator: { folder: "INBOX", ref: "1:5" } }, { type: "move", to: "ohmail/News" });
    expect(out.state.desiredFolder).toBe("ohmail/News");
  });
});
