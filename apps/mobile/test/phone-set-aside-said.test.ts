import { afterEach, describe, expect, it } from "vitest";
import { forgetOrganizerSessionForTests, holdStandaloneDoor, standaloneHere } from "../src/engine/organizer-session";
import type { StandaloneEngine } from "../src/engine/standalone-door";
import { setAsideSaid } from "../src/state/live";
import { Copy } from "../src/copy";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";

/**
 * MESSAGES THIS PHONE SET ASIDE REACH ITS SCREEN (LOCAL-WRITTEN-OFF-MESSAGE-IS-NOT-SHOWN). The engine
 * counts the unresolved write-offs it holds; the session sums them over the door's mailboxes and the
 * selector says one closed-set sentence, a count only, or nothing.
 */
function door(...setAside: Array<number | undefined>): StandaloneEngine {
  const no = async (): Promise<never> => { throw new Error("not driven by this case"); };
  const connection = Object.fromEntries(setAside.map((n, i) => [`m${i + 1}`, {
    reachable: true, unreachableSince: null, signInRefused: false, firstSync: "finished",
    ...(n !== undefined ? { setAside: n } : {}),
  }]));
  return {
    accountId: "engine-account", address: "aside@example.test", sessionToken: "engine-launch-token",
    handle: no, stop: async () => undefined, log: () => undefined,
    handBack: async () => [{ mailboxId: "m1", released: 1 }], leave: () => undefined,
    forgetStoredLogin: async () => true, serverSettings: async () => null,
    resume: async () => [{ mailboxId: "m1", served: 1 }],
    claimHere: no, heldElsewhere: async () => null, stopOrganizing: no,
    runtimes: () => ({
      organizer: { m1: { organizing: true, heldBy: null, reason: null, releaseRequestedAt: null, claimed: true } },
      connection,
    }),
  };
}

describe("messages set aside, from the engine to the phone's line", () => {
  afterEach(() => { forgetOrganizerSessionForTests(); });
  const said = () => setAsideSaid(standaloneHere());

  it("one message set aside is said in the singular", () => {
    expect(holdStandaloneDoor(door(1))).toBe(true);
    expect(standaloneHere()!.setAside).toBe(1);
    expect(said()).toBe(Copy.connectionSetAside(1));
    expect(EN.connectionSetAside(1)).toBe("One message could not be read and was set aside.");
  });

  it("the count is summed over the door's mailboxes", () => {
    expect(holdStandaloneDoor(door(2, 3))).toBe(true);
    expect(said()).toBe(Copy.connectionSetAside(5));
    expect(EN.connectionSetAside(5)).toBe("5 messages could not be read and were set aside.");
  });

  it("CONTROL: none set aside, an engine older than the field, and a value that is not a count say nothing", () => {
    expect(holdStandaloneDoor(door(0))).toBe(true);
    expect(said()).toBeNull();
    forgetOrganizerSessionForTests();
    expect(holdStandaloneDoor(door(undefined))).toBe(true);
    expect(standaloneHere()!.setAside).toBe(0);
    expect(said()).toBeNull();
    forgetOrganizerSessionForTests();
    expect(holdStandaloneDoor(door(1.5))).toBe(true);
    expect(said()).toBeNull();
    expect(setAsideSaid(null)).toBeNull();
  });

  /* No server clause: a set-aside message or its folder can be gone from the server, so "it stays on
     your server" is not always true. A count, and nothing about the message. */
  it("both decks say a count and nothing else, and promise nothing about the server", () => {
    for (const deck of [EN, DE]) {
      for (const n of [1, 7]) {
        const s = deck.connectionSetAside(n);
        expect(s).not.toMatch(/Server|server|@|Subject|Betreff/);
      }
    }
    expect(DE.connectionSetAside(1)).toBe("Eine Nachricht konnte nicht gelesen werden und wurde zurückgelegt.");
  });
});
