import { describe, expect, it } from "vitest";
import { makeEntitlementsClient, type EntitlementsFetch } from "../src/entitlements-client.js";

/**
 * THE REFUND'S ANSWER — `release` says whether the program took it, and a caller that owes money
 * back can read that.
 *
 * The mechanism this file exists for: AI drafting spends, the drafter fails, the refund is
 * attempted, the program is unreachable, and the reversal is lost with nobody holding the debt.
 * `release` used to answer `void`, so "the credits are back" and "the credits are gone" were the
 * same value at every call site — and the one sentence a person could be shown was the wrong one
 * half the time. The receipt is what makes the obligation writable.
 */

/** A program that answers 200 to everything. */
const answering: EntitlementsFetch = async () => ({ status: 200, json: async () => ({ ok: true }) });

/** A program that is not there. The outage half, which is the case the receipt exists for. */
const unreachable: EntitlementsFetch = async () => { throw new Error("ECONNREFUSED"); };

/** A program that is there and refuses. A 503 is not a taken release either. */
const refusing: EntitlementsFetch = async () => ({ status: 503, json: async () => ({}) });

const client = (fetchImpl: EntitlementsFetch) => makeEntitlementsClient({
  baseUrl: "https://entitlements.test", secret: "s", fetchImpl,
  onCallFault: () => { /* the outage is reported elsewhere; this file reads the receipt */ },
});

const refund = { action: "draft", attemptKey: "m1", refund: true, attempt: "a1" } as const;
const give_back = { action: "draft", attemptKey: "m1", refund: false } as const;

describe("the entitlements client's release receipt", () => {
  it("answers `settled` when the program took the reversal", async () => {
    expect(await client(answering).release("acct", refund)).toBe("settled");
  });

  it("answers `unreachable` when nothing answered — the lost-refund case", async () => {
    expect(await client(unreachable).release("acct", refund)).toBe("unreachable");
  });

  it("answers `unreachable` for a program that answered and refused", async () => {
    expect(await client(refusing).release("acct", refund)).toBe("unreachable");
  });

  it("answers for a claim-only release too, so one door reports one way", async () => {
    expect(await client(answering).release("acct", give_back)).toBe("settled");
    expect(await client(unreachable).release("acct", give_back)).toBe("unreachable");
  });

  it("still never throws — a lost release may not become the caller's error", async () => {
    await expect(client(unreachable).release("acct", refund)).resolves.toBe("unreachable");
  });
});
