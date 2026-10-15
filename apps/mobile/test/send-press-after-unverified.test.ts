import { describe, expect, it } from "vitest";
import { sendPressAct } from "../src/ui/send-press";
import { failedSendCopy } from "../src/state/live";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";

/**
 * SEND IS NEVER A PRESS THAT DOES NOTHING, AND A FAILED SEND SAYS WHAT FAILED.
 *
 * After "We couldn't confirm this send" the composer's Send was disabled: the server could not say
 * whether the first message left, so a fresh send could reach the recipient twice — but a dead
 * button told nobody that. The press now answers with why nothing was sent again. A send that never
 * secured its connection or had its login refused offered nothing, and the phone names that step
 * instead of the generic "Sending didn't work". Mutation: `again` → `none` fails case 1.
 */

describe("a press on Send, by the composer's state", () => {
  it("over an unconfirmed send it answers instead of doing nothing", () => {
    expect(sendPressAct({ canSend: false, contentOnlyMissing: false, phase: "unverified" })).toBe("again");
  });

  it("keeps the other locks: sending and a queued retry stay locked, content-only asks for content", () => {
    expect(sendPressAct({ canSend: false, contentOnlyMissing: false, phase: "sending" })).toBe("none");
    expect(sendPressAct({ canSend: false, contentOnlyMissing: false, phase: "queued" })).toBe("none");
    expect(sendPressAct({ canSend: false, contentOnlyMissing: true, phase: "idle" })).toBe("needContent");
    expect(sendPressAct({ canSend: true, contentOnlyMissing: false, phase: "idle" })).toBe("send");
  });
});

describe("the sentence a failed send earns", () => {
  const rejected = (code: string) => ({ id: "m", key: "k", status: "rolled_back" as const, seq: null, error: { code, message: "" } as never });

  it("names the step for a session that offered nothing, and keeps the plain one otherwise", () => {
    expect(failedSendCopy(rejected("send_not_secured"))).toBe("replyNotSecured");
    expect(failedSendCopy(rejected("send_login_refused"))).toBe("replyLoginRefused");
    expect(failedSendCopy(rejected("send_timeout"))).toBe("replyFailed");
    expect(failedSendCopy(null)).toBe("replyFailed");
  });

  it("every sentence exists in both catalogues", () => {
    for (const key of ["replyNotSecured", "replyLoginRefused", "replyUnverifiedAgain"] as const) {
      expect(typeof EN[key]).toBe("string");
      expect(typeof DE[key]).toBe("string");
      expect(DE[key]).not.toBe(EN[key]);
    }
  });
});
