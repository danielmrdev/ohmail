import { describe, it, expect } from "vitest";
import { profileImportResolutionExists, recordProfileImportResolution } from "@trafficflow/db";
import { makeTestDb } from "../src/testing.js";

/**
 * A NEWER-FORMAT "NOT NOW", READ BACK ON BOTH STORES — one file, two runs.
 *
 * The dismissal is keyed to the refused version, compared as TEXT. The device store's `->>`
 * answers a JSON number as an INTEGER and never equals a TEXT, so the phone recorded the answer
 * and never read it back: its gate held every stranger for as long as that document stood.
 * `audit_log` has no foreign key, so both projects seed and run this identically.
 */
const ACCOUNT = "00000000-0000-4000-8000-0000000000ab";
const MAILBOX = "00000000-0000-4000-8000-0000000000ac";

describe("a newer-format dismissal, on whichever store this is", () => {
  it("is found by its version, and a different version is not", async () => {
    const db = await makeTestDb();
    const at = { accountId: ACCOUNT, mailboxId: MAILBOX };
    expect(await profileImportResolutionExists(db, { ...at, newerV: 99 })).toBe(false);
    await recordProfileImportResolution(db, { ...at, decision: "declined", newerV: 99 });
    expect(await profileImportResolutionExists(db, { ...at, newerV: 99 })).toBe(true);
    expect(await profileImportResolutionExists(db, { ...at, newerV: 98 })).toBe(false);
    // Written once: the duplicate check reads the same comparison.
    await recordProfileImportResolution(db, { ...at, decision: "declined", newerV: 99 });
    expect(await profileImportResolutionExists(db, { ...at, newerV: 99 })).toBe(true);
  });

  it("a version past 2^31 is compared, not cast, on both stores", async () => {
    const db = await makeTestDb();
    const at = { accountId: ACCOUNT, mailboxId: MAILBOX };
    await recordProfileImportResolution(db, { ...at, decision: "declined", newerV: 2 ** 40 });
    expect(await profileImportResolutionExists(db, { ...at, newerV: 2 ** 40 })).toBe(true);
  });
});
