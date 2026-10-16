import { describe, it, expect } from "vitest";
import { ImapBoundExceeded } from "@trafficflow/core/adapters/imap";
import { breachSetAside, DeadLetterLedger, HOLD_EXEMPT_CODES } from "../src/dead-letter.js";

/**
 * THE HOLD'S RUN AND THE PROGRESS PREDICATE, at the ledger. A
 * `mime_too_large` write-off is a bound applied to the server's bytes: the backstop's run never counts
 * it and a standing hold never refuses it, while the per-cycle cap still does. `breachSetAside` is
 * true only for a per-message overrun whose message this ledger wrote off.
 */
const loc = (uid: number) => ({ folder: "INBOX", ref: `100:${uid}` });
const overrun = { code: "mime_too_large" as const, deterministic: true };
const ordinary = { code: "mime_unparseable" as const, deterministic: true };
const breachAt = (uid: number) =>
  new ImapBoundExceeded("body_overrun", 1_000, 2_000_000, "INBOX", { uidValidity: "100", uid });

describe("the hold-exempt codes", () => {
  it("the list is mime_too_large and nothing else", () => {
    expect([...HOLD_EXEMPT_CODES]).toEqual(["mime_too_large"]);
  });

  it("six overruns in one cycle: five taken, the sixth refused by the cap, taken next cycle, no hold", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    const verdicts = [1, 2, 3, 4, 5, 6].map((u) => dl.record(loc(u), overrun));
    dl.beginCycle();
    expect(verdicts).toEqual(["skip", "skip", "skip", "skip", "skip", "retry"]);
    expect(dl.record(loc(6), overrun)).toBe("skip");
    expect(dl.writeOffsHeldSince).toBeNull();
  });

  it("a standing hold refuses an ordinary write-off and admits an overrun", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    dl.hydrateRun({ count: 5, heldSince: new Date() });
    expect(dl.record(loc(7), ordinary)).toBe("retry");
    expect(dl.record(loc(8), overrun)).toBe("skip");
  });

  it("CONTROL: five ordinary write-offs hold, and an overrun after them in that cycle is refused by the cap", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    const ord = [1, 2, 3, 4, 5].map((u) => dl.record(loc(u), ordinary));
    expect(ord).toEqual(["skip", "skip", "skip", "skip", "skip"]);
    expect(dl.writeOffsHeldSince).not.toBeNull();
    expect(dl.record(loc(6), overrun)).toBe("retry");
  });

  it("revoking an overrun leaves the run alone; revoking an ordinary one gives its place back", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    for (const u of [1, 2, 3, 4]) dl.record(loc(u), ordinary);
    dl.record(loc(5), overrun);
    dl.revoke(loc(5));
    expect(dl.writeOffsHeldSince, "an overrun's revoke lowered the run").toBeNull();
    dl.beginCycle();
    dl.record(loc(6), ordinary);
    expect(dl.writeOffsHeldSince, "the fifth ordinary write-off did not hold").not.toBeNull();
  });
});

describe("breachSetAside: progress is a committed set-aside", () => {
  it("true for the breach whose message this ledger wrote off", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    expect(dl.record(loc(3), overrun)).toBe("skip");
    expect(breachSetAside(breachAt(3), dl)).toBe(true);
  });

  it("false for a row an EARLIER cycle wrote: a re-read of an older set-aside is no progress", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    expect(dl.record(loc(3), overrun)).toBe("skip");
    dl.beginCycle();
    expect(dl.record(loc(3), overrun), "the row was not already written off").toBe("skip");
    expect(dl.has("INBOX", "100", 3)).toBe(true);
    expect(breachSetAside(breachAt(3), dl)).toBe(false);
  });

  it("false when the cap refused the set-aside, so the row was never written", () => {
    const dl = new DeadLetterLedger({ holdAtCap: false });
    dl.beginCycle();
    for (const u of [1, 2, 3, 4, 5]) dl.record(loc(u), ordinary);
    expect(dl.record(loc(6), overrun)).toBe("retry");
    expect(breachSetAside(breachAt(6), dl)).toBe(false);
  });

  it("false when the row write failed and the decision was revoked", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    dl.record(loc(3), overrun);
    dl.revoke(loc(3));
    expect(breachSetAside(breachAt(3), dl)).toBe(false);
  });

  it("false for a batch-total breach that names no message, another bound, or another message", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    dl.record(loc(3), overrun);
    expect(breachSetAside(new ImapBoundExceeded("body_overrun", 1_000, 2_000_000, "INBOX"), dl)).toBe(false);
    expect(breachSetAside(new ImapBoundExceeded("read_deadline", 1_000, 2_000, "INBOX", { uidValidity: "100", uid: 3 }), dl)).toBe(false);
    expect(breachSetAside(breachAt(4), dl)).toBe(false);
    expect(breachSetAside(new Error("socket said something odd"), dl)).toBe(false);
    expect(breachSetAside(breachAt(3), undefined)).toBe(false);
  });
});
