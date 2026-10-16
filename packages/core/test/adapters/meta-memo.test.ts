import { describe, expect, it, beforeEach } from "vitest";

import {
  readMemo, writeMemo, forgetMemo, resetMetaMemos, MetaIdentityError,
} from "../../src/adapters/meta-memo.js";

const A = { installId: "install-a", mailboxId: "mailbox-1" };
const B = { installId: "install-b", mailboxId: "mailbox-1" };
const GEN = 1_000;

describe("what one install remembers about one mailbox", () => {
  beforeEach(() => { resetMetaMemos(); });

  it("gives back what it was told, under the generation it was told it", () => {
    writeMemo(A, GEN, { claimUid: 42 });

    const read = readMemo(A, GEN);

    expect(read.kind).toBe("memo");
    expect(read.kind === "memo" && read.memo.claimUid).toBe(42);
  });

  /**
   * ── THE RECONNECT CASE, which the connection-keyed version could not pass ──────────────────
   *
   * A reconnect changes nothing about the folder. Keyed by the connection object, every position
   * was lost on one — so a walk that had got somewhere started again from the top for a reason
   * that had nothing to do with the mailbox. Nothing here is tied to a connection, so the memo
   * simply survives.
   */
  it("survives a reconnect, because it was never tied to a connection", () => {
    writeMemo(A, GEN, { sweepCursor: 5_000 });

    // No connection object exists in this test at all — that is the point.
    const read = readMemo(A, GEN);

    expect(read.kind === "memo" && read.memo.sweepCursor).toBe(5_000);
  });

  /**
   * ── AND A DIFFERENT INSTALL NEVER READS IT ────────────────────────────────────────────────
   *
   * The positions here decide how far down a folder a search looks. One install reading another's
   * would search from the wrong floor and answer short while looking complete, which for the claim
   * read is how a mailbox ends up with two organizers.
   */
  it("is not visible to another install on the same mailbox", () => {
    writeMemo(A, GEN, { claimUid: 42 });

    expect(readMemo(B, GEN).kind, "another install read this install's memory").toBe("empty");
  });

  /**
   * ── A REPLACED FOLDER EMPTIES IT, AND SAYS SO ─────────────────────────────────────────────
   *
   * `invalidated` is a distinct answer from `empty` on purpose. Both mean "no position to use",
   * but only one of them means "and here is why your walk is starting from the top" — without it a
   * mailbox stuck behind a renumbering is indistinguishable from a quiet one.
   */
  it("discards a memory from a replaced numbering and reports the discard", () => {
    writeMemo(A, GEN, { claimUid: 42, sweepCursor: 900 });

    const read = readMemo(A, GEN + 1);

    expect(read.kind).toBe("invalidated");
    expect(read.kind === "invalidated" && read.was).toBe(GEN);
    expect(read.kind === "invalidated" && read.now).toBe(GEN + 1);
    // AND IT IS GONE, not merely declined: a second read finds nothing to reconsider.
    expect(readMemo(A, GEN).kind, "the stale memory survived the read that rejected it").toBe("empty");
  });

  /**
   * ── NOT KNOWING IS NOT DISAGREEING ────────────────────────────────────────────────────────
   *
   * A reader that cannot learn the folder's generation must not USE a position — but it must not
   * destroy one either. This entry is shared by four of them, so treating "I could not check" as
   * "this is stale" let one blind reader clear the claim anchor, the settings anchor and the
   * sweep's place along with its own. That is what `unusable` exists to separate from
   * `invalidated`, and the surviving entry below is the half that matters.
   */
  it("declines to answer an unknown generation, and keeps the entry for readers that can check", () => {
    writeMemo(A, GEN, { claimUid: 42 });

    expect(readMemo(A, null).kind, "a memo was used against an unknown generation").toBe("unusable");
    const still = readMemo(A, GEN);
    expect(still.kind === "memo" && still.memo.claimUid,
      "a reader that could not check the generation destroyed a position it could not read").toBe(42);

    resetMetaMemos();
    // A position that cannot be checked for staleness LATER is still not worth keeping at all.
    writeMemo(A, null, { claimUid: 42 });
    expect(readMemo(A, GEN).kind, "a position was kept under no generation").toBe("empty");
  });

  it("compares generations by value across number and bigint", () => {
    writeMemo(A, 7, { claimUid: 1 });
    expect(readMemo(A, BigInt(7)).kind,
      "the same folder looked replaced because the type changed on the wire").toBe("memo");
  });

  /**
   * ── AND `0` IS THE SAME UNKNOWN AS `null` ─────────────────────────────────────────────────
   *
   * "An unknown generation on either side is a mismatch" was true of `null` and false of every
   * other way a server has of not naming one. `0` is not a UIDVALIDITY (RFC 3501 §2.3.1.1), and it
   * arrived here as an ordinary number: two folders neither of which named a generation compared
   * EQUAL, so the claim read's search FLOOR — a position in a numbering that no longer exists —
   * was reused across a replacement, which returns a short claim set that looks complete. Both
   * halves of the module go through `epoch.ts` now.
   *
   * MUTATIONS (2026-09-12, every restore verified by `cmp`):
   *  · RED — the `readMemo` guard back to `generation === null` ⇒ both cases here redden, with a
   *    position handed back under a generation nobody named;
   *  · GREEN, and the answer is in the source — `sameGeneration` back to `BigInt(a) === BigInt(b)`
   *    behind a null check changes nothing, because the two guards turn an unnamed generation away
   *    before it can reach the comparison. The decision is the guards; the comparison routes
   *    through the door so there is one notion of sameness here, not two.
   */
  it("treats a zero generation as unknown, on both sides and at the write", () => {
    writeMemo(A, GEN, { claimUid: 42 });
    expect(readMemo(A, 0).kind,
      "a position was used under a generation the server did not name").toBe("unusable");
    // …and the entry survives that read, exactly as it survives a `null` one: a reader that cannot
    // check a position must not clear three other readers' positions with it.
    expect(readMemo(A, GEN).kind).toBe("memo");

    resetMetaMemos();
    writeMemo(A, 0, { claimUid: 42 });
    expect(readMemo(A, GEN).kind, "a position was kept under a zero generation").toBe("empty");
    // Nothing was stored, so the read is `empty` rather than `unusable`: `unusable` says "there is
    // something here you may not use", and after a refused write there is not.
    expect(readMemo(A, 0).kind).toBe("empty");
  });

  it("treats a generation past RFC 3501's ceiling as unknown too", () => {
    // 2^32 is out of range for a `nz-number`, so it names no epoch and cannot validate a position.
    writeMemo(A, GEN, { claimUid: 42 });
    expect(readMemo(A, 4_294_967_296).kind).toBe("unusable");
    expect(readMemo(A, 4_294_967_295).kind,
      "POSITIVE CONTROL — the largest real epoch still names one").toBe("invalidated");
  });

  it("merges within a generation and replaces across one", () => {
    writeMemo(A, GEN, { claimUid: 42 });
    writeMemo(A, GEN, { sweepCursor: 900 });
    const both = readMemo(A, GEN);
    expect(both.kind === "memo" && both.memo.claimUid).toBe(42);
    expect(both.kind === "memo" && both.memo.sweepCursor).toBe(900);

    // A renumbered folder shares nothing with the one before it.
    writeMemo(A, GEN + 1, { sweepCursor: 5 });
    const after = readMemo(A, GEN + 1);
    expect(after.kind === "memo" && after.memo.claimUid,
      "a position from the previous numbering survived into the new one").toBeUndefined();
  });

  it("forgets one field without disturbing the others", () => {
    writeMemo(A, GEN, { claimUid: 42, sweepCursor: 5_000 });
    forgetMemo(A, "claimUid");
    const read = readMemo(A, GEN);
    expect(read.kind === "memo" && read.memo.claimUid).toBeUndefined();
    expect(read.kind === "memo" && read.memo.sweepCursor).toBe(5_000);
  });

  /**
   * ── THE SEPARATOR IS PART OF THE KEY'S CORRECTNESS ────────────────────────────────────────
   *
   * Joining the two fields on any character either of them may contain lets two distinct
   * identities produce one key. That is the cross-install leak the key exists to prevent, put back
   * by the separator, and it would be invisible in every ordinary test.
   */
  it("does not collide when an id contains the separator's plausible substitutes", () => {
    writeMemo({ installId: "a b", mailboxId: "c" }, GEN, { claimUid: 1 });
    writeMemo({ installId: "a", mailboxId: "b c" }, GEN, { claimUid: 2 });

    const first = readMemo({ installId: "a b", mailboxId: "c" }, GEN);
    const second = readMemo({ installId: "a", mailboxId: "b c" }, GEN);

    expect(first.kind === "memo" && first.memo.claimUid).toBe(1);
    expect(second.kind === "memo" && second.memo.claimUid,
      "two different identities shared one memory").toBe(2);
  });

  /**
   * THE RUN-TIME CHECK. The tests in this package are not typechecked, so a construction site that
   * omits an identity binds `undefined` rather than failing a build — and every mailbox in the
   * process would then share one entry. This is the only thing that catches it.
   */
  it("refuses an identity it cannot key a memory by", () => {
    expect(() => writeMemo({ installId: "  ", mailboxId: "m" }, GEN, {}))
      .toThrow(MetaIdentityError);
    expect(() => readMemo({ installId: "i", mailboxId: "" }, GEN))
      .toThrow(/no usable mailbox id/);
    expect(() => readMemo(undefined as unknown as typeof A, GEN))
      .toThrow(/no usable identity/);
  });
});
