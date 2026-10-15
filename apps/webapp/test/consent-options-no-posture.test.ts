import { describe, expect, it } from "vitest";
import type { ConsentOptions } from "@ohmail/client-engine";

/**
 * ARCH-R902 — THE PARTITION TAKES NO POSTURE. A letter presents at its folder as the wire states it
 * in every posture — this install organizing, a reader, nothing organizing — so `ConsentOptions`
 * carries no role: a posture key there would be a default branch nobody tests against the lease.
 * The record must name every key (one added without it fails to typecheck here, and this directory
 * typechecks its tests) and none may be about who organizes.
 */
const KEYS = {
  now: true, foldersEnabled: true, dormancyDays: true, baselineAt: true,
  screeningScope: true, ownAddresses: true, rulesOnly: true, firstImportDoneAt: true,
  // RULING-026: each mailbox's WINDOW, never whose it is (`ScreeningSource` stays out of the options).
  byMailbox: true,
} as const satisfies Record<keyof ConsentOptions, true>;

describe("the consent partition's options", () => {
  it("are these nine keys, and none of them is about who organizes the mailbox", () => {
    expect(Object.keys(KEYS).sort()).toEqual([
      "baselineAt", "byMailbox", "dormancyDays", "firstImportDoneAt", "foldersEnabled", "now", "ownAddresses", "rulesOnly",
      "screeningScope",
    ]);
    expect(Object.keys(KEYS).filter((k) => /role|organi[sz]|reader|posture|lease|install/i.test(k))).toEqual([]);
  });
});
