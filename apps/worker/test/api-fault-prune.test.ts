import { describe, it, expect, vi } from "vitest";
import { apiFaultPrunePass } from "../src/api-fault-prune.js";
import type { Tx } from "@trafficflow/db";

/**
 * THE PASS'S ONE PROMISE: it never throws.
 *
 * It runs immediately after the alert pass inside that pass's own `try`, on a timer, in a worker
 * that is syncing mail. A rejection here would take the worker down over a retention sweep — and
 * the ordinary reason for one is a host deployed ahead of cloud 0033, which is not an emergency.
 */

function logger(): { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), info: vi.fn() };
}

/** A handle whose `delete` chain rejects — the shape a 42P01 arrives in. */
function refusingDb(err: unknown): Tx {
  return { delete: () => ({ where: () => Promise.reject(err) }) } as unknown as Tx;
}

/** A handle that reports N rows removed, the way postgres-js does. */
function countingDb(count: number): Tx {
  return { delete: () => ({ where: () => Promise.resolve({ count }) }) } as unknown as Tx;
}

describe("api_faults retention pass", () => {
  it("swallows a missing table and reports zero", async () => {
    const log = logger();
    const err = Object.assign(new Error('relation "api_faults" does not exist'), { code: "42P01" });
    await expect(apiFaultPrunePass(refusingDb(err), new Date(), log as never)).resolves.toBe(0);
    expect(log.warn).toHaveBeenCalledWith("api_fault_prune_failed", expect.objectContaining({ err }));
    expect(log.info).not.toHaveBeenCalled();
  });

  it("swallows a THROWN STRING too — the class with no message to log", async () => {
    // `organizer_profile_write_failed` lost the payload of a thrown string, so a pass that must
    // never throw is driven with one: a `catch` that reads `err.message` off a primitive is the
    // way this promise breaks.
    const log = logger();
    await expect(apiFaultPrunePass(refusingDb("boom"), new Date(), log as never)).resolves.toBe(0);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("logs the drain ONLY when something was removed", async () => {
    const quiet = logger();
    await expect(apiFaultPrunePass(countingDb(0), new Date(), quiet as never)).resolves.toBe(0);
    // A line every cadence saying "removed 0" is the noise an operator learns to skim.
    expect(quiet.info).not.toHaveBeenCalled();

    const loud = logger();
    await expect(apiFaultPrunePass(countingDb(4), new Date(), loud as never)).resolves.toBe(4);
    expect(loud.info).toHaveBeenCalledWith("api_fault_prune", expect.objectContaining({ removed: 4 }));
  });

  it("passes the retention it was handed, not a second copy of the default", async () => {
    // The horizon has one home (`API_FAULT_RETENTION_MS`) and the pass takes an override so a
    // test can reach the boundary; a pass that ignored the argument would make every caller's
    // number decorative.
    const log = logger();
    let seen: number | null = null;
    const db = {
      delete: () => ({
        where: (frag: unknown) => { seen = String(frag).length; return Promise.resolve({ count: 0 }); },
      }),
    } as unknown as Tx;
    await apiFaultPrunePass(db, new Date(), log as never, 1000);
    expect(seen).not.toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
