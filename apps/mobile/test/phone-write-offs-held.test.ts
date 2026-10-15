import { afterEach, describe, expect, it } from "vitest";
import { forgetOrganizerSessionForTests, holdStandaloneDoor, standaloneHere } from "../src/engine/organizer-session";
import type { StandaloneEngine } from "../src/engine/standalone-door";
import { connectionSaid, connectionSay } from "../src/state/live";
import { Copy } from "../src/copy";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";

/**
 * THE ENGINE'S HELD WRITE-OFFS REACH THE PHONE'S TOP LINE. The local backstop stops setting mail
 * aside once a cycle spent its cap with mail still failing; the link is up, so without this read the
 * strip said nothing over a mailbox whose mail had stopped (REVIEW-026-PHONE-ONE-MESSAGE-B L1).
 */
function door(writeOffsHeldSince: Date | null | undefined, storeFaultSince?: Date | null): StandaloneEngine {
  const no = async (): Promise<never> => { throw new Error("not driven by this case"); };
  return {
    accountId: "engine-account", address: "held@example.test", sessionToken: "engine-launch-token",
    handle: no, stop: async () => undefined, log: () => undefined,
    handBack: async () => [{ mailboxId: "m1", released: 1 }], leave: () => undefined,
    forgetStoredLogin: async () => true, serverSettings: async () => null,
    resume: async () => [{ mailboxId: "m1", served: 1 }],
    claimHere: no, heldElsewhere: async () => null, stopOrganizing: no,
    runtimes: () => ({
      organizer: { m1: { organizing: true, heldBy: null, reason: null, releaseRequestedAt: null, claimed: true } },
      connection: { m1: {
        reachable: true, unreachableSince: null, signInRefused: false, firstSync: "finished",
        ...(writeOffsHeldSince !== undefined ? { writeOffsHeldSince } : {}),
        ...(storeFaultSince !== undefined ? { storeFaultSince } : {}),
      } },
    }),
  };
}

describe("held write-offs, from the engine to the top line", () => {
  afterEach(() => { forgetOrganizerSessionForTests(); });
  const say = () => connectionSaid(connectionSay(standaloneHere(), new Date(), "Europe/Zurich"));

  it("an engine holding its write-offs says so over a link that is up", () => {
    expect(holdStandaloneDoor(door(new Date("2026-10-03T08:00:00Z")))).toBe(true);
    expect(standaloneHere()!.writeOffsHeld).toBe(true);
    expect(say()).toBe(Copy.connectionMailHeld);
  });

  it("a store that refuses the mail says the same, with nothing written off", () => {
    expect(holdStandaloneDoor(door(null, new Date("2026-10-04T05:00:00Z")))).toBe(true);
    expect(standaloneHere()!.writeOffsHeld).toBe(true);
    expect(say()).toBe(Copy.connectionMailHeld);
  });

  it("the held sentence claims no paused sync: an old write-off can re-fail while mail is saved", () => {
    for (const deck of [EN, DE]) {
      expect(deck.connectionMailHeld).not.toMatch(/pause|angehalten|Synchronisierung/i);
      expect(deck.connectionMailHeld).toMatch(/server|Server/);
    }
  });

  it("CONTROL: not held, or an engine older than the field, says nothing", () => {
    expect(holdStandaloneDoor(door(null, null))).toBe(true);
    expect(say()).toBeNull();
    forgetOrganizerSessionForTests();
    expect(holdStandaloneDoor(door(undefined))).toBe(true);
    expect(standaloneHere()!.writeOffsHeld).toBe(false);
    expect(say()).toBeNull();
  });
});
