import { describe, it, expect } from "vitest";
import { formatStorageBytes, storageState, STORAGE_NEAR_CAP_RATIO } from "../app/shell/storage-state";
import type { SubscriptionStatus } from "../app/api-client";

/**
 * THE STORAGE SENTENCE'S DERIVATION — pure over the DTO. No pane calls it now; the module's
 * own header says why it stays.
 *
 * The absent-field cases carry the weight: `storageUsedBytes` and
 * `entitlements.storageBytesLimit` are optional on the wire (an older server omits them), and
 * absence must mean "say nothing", never "0 of 0" — a row that rendered every account as at
 * once empty and capped would be the exact broken claim the optional-read rule
 * (`trialCredits`'s) exists to prevent.
 */
function dto(over: {
  used?: number | undefined;
  cap?: number | undefined;
}): SubscriptionStatus {
  return {
    subscription: null,
    balance: 0,
    ...(over.used !== undefined ? { storageUsedBytes: over.used } : {}),
    entitlements: {
      mailboxLimit: 5, canAddMailbox: true, aiEnabled: true, syncEnabled: true,
      ...(over.cap !== undefined ? { storageBytesLimit: over.cap } : {}),
      reason: "active",
    },
    plans: {},
  } as SubscriptionStatus;
}

describe("storageState", () => {
  it("says nothing below ninety percent — the row's numbers are the whole statement", () => {
    expect(storageState(dto({ used: 0, cap: 5_000_000_000 }))).toBeNull();
    expect(storageState(dto({ used: 4_499_999_999, cap: 5_000_000_000 }))).toBeNull();
  });

  it("near_cap from exactly ninety percent; at_cap from exactly the cap", () => {
    const cap = 5_000_000_000;
    const near = Math.ceil(cap * STORAGE_NEAR_CAP_RATIO);
    expect(storageState(dto({ used: near, cap }))).toEqual({ kind: "near_cap", usedBytes: near, capBytes: cap });
    expect(storageState(dto({ used: cap, cap }))).toEqual({ kind: "at_cap", usedBytes: cap, capBytes: cap });
    // Over-cap (the crossing message's bounded overshoot) is still at_cap, not a fourth state.
    expect(storageState(dto({ used: cap + 999, cap }))?.kind).toBe("at_cap");
  });

  it("an absent figure — either one — says NOTHING, and so does a zero cap", () => {
    expect(storageState(dto({ used: undefined, cap: 5_000_000_000 }))).toBeNull();
    expect(storageState(dto({ used: 100, cap: undefined }))).toBeNull();
    // Cap 0 is the zero-entitlement shape, whose syncEnabled:false already stops ingest — a
    // full-red storage row on a suspended account would name the wrong problem.
    expect(storageState(dto({ used: 100, cap: 0 }))).toBeNull();
    expect(storageState(null)).toBeNull();
  });
});

describe("formatStorageBytes", () => {
  it("is DECIMAL, so the card's number is the enforced number", () => {
    expect(formatStorageBytes(5_000_000_000, "en")).toBe("5 GB");
    expect(formatStorageBytes(15_000_000_000, "en")).toBe("15 GB");
    expect(formatStorageBytes(50_000_000_000, "en")).toBe("50 GB");
  });

  it("one decimal under 10 GB, steps down below 1 GB — a fresh account never reads '0 GB'", () => {
    expect(formatStorageBytes(1_230_000_000, "en")).toBe("1.2 GB");
    expect(formatStorageBytes(12_000_000, "en")).toBe("12 MB");
    expect(formatStorageBytes(3_400, "en")).toBe("3 KB");
    expect(formatStorageBytes(12, "en")).toBe("12 B");
  });

  /**
   * THE SEPARATOR FOLLOWS THE READER'S LANGUAGE, and the locale is an argument rather than a
   * default so it cannot quietly become the computer's.
   *
   * A size with a decimal point in a German pane reads ten times larger — a decimal point is a thousands
   * separator there — and it sat directly beside an email count the catalogue grouped
   * correctly, so one row carried two conventions. Both locales are asserted explicitly: a
   * case that passed no locale would agree with whatever machine happened to run it.
   */
  it("follows the reader's language, both ways", () => {
    expect(formatStorageBytes(1_500_000_000, "de")).toBe("1,5 GB");
    expect(formatStorageBytes(1_500_000_000, "en")).toBe("1.5 GB");
    // Whole numbers are the same word in both, which is why the decimal case is the one to pin.
    expect(formatStorageBytes(2_000_000_000, "de")).toBe("2 GB");
    // …and a large sub-gigabyte figure groups: in megabytes it has no separator, in kilobytes it would.
    expect(formatStorageBytes(999_000_000, "de")).toBe("999 MB");
  });
});
