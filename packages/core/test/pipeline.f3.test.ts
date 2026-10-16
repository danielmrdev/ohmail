import { describe, it, expect } from "vitest";
import { planChange, commitChange , UNMETERED_STORAGE_CAP} from "../src/pipeline.js";
import { FakeRepo, dedupKeyFor } from "./fakes.js";
import type { Change, NativeLocator } from "../src/ports.js";

/**
 * THE MOVE THAT COPIED BUT NEVER EXPUNGED.
 *
 * `imap.ts#move` on a server without RFC 6851 MOVE is COPY (phase 1) → verify (phase 2) → expunge
 * the source (phase 3). Three network operations across the IMAP boundary, so no isolation level
 * can join them. When phase 3 fails the message exists TWICE, and the next cycle observes the
 * destination copy as an ordinary `create` because its UID is not in `listKnownLocators`.
 *
 * Two things follow, and they are one change because neither works alone.
 *
 * The move is NOT complete. A copy sitting in the folder we wanted it in looks like success from
 * this one observation, but the source is still on the server and the only thing that ever removes
 * it is a retry of this very move. So `folder_state` stays pending, the primary instance stays at
 * the SOURCE — the locator the retry must be handed — and the destination copy is recorded as a
 * second instance, which is what stops it being rediscovered next cycle as a stranger costing a
 * full RFC822 re-fetch.
 *
 * That is only safe because `imap.ts#move` reads the destination before it writes: on the retry it
 * recognises the copy it already made, writes nothing, and performs the expunge it still owes.
 * Withhold completion without that pre-check and every cycle adds another copy for ever. The two
 * halves of this fix ship together or not at all.
 */

const SRC = "INBOX";
const DST = "ohmail/News";
const SRC_LOC: NativeLocator = { folder: SRC, ref: "1:10" };
const DST_LOC: NativeLocator = { folder: DST, ref: "7:41" };

function eml(body = "the ridge beam is 240mm"): Buffer {
  return Buffer.from([
    "Message-ID: <f3@example.com>",
    "From: anna@example.com",
    "To: mila@lichtgrat.example",
    "Subject: Roof detail",
    "Content-Type: text/plain; charset=utf-8",
    "", body,
  ].join("\r\n"));
}

const accountId = "acct-1";
const mailboxId = "mb-1";

/**
 * The database state `reconcileFolders` leaves behind when `adapter.move` throws in PHASE 3.
 *
 * COPY landed, EXPUNGE did not. Neither `updateLocator` nor `upsertFolderState` was reached, so
 * the row still points at the SOURCE and the move is still pending. Seeded verbatim rather than
 * described, because the whole finding is about which of those two facts the next observation
 * is allowed to read as completion.
 */
async function interruptedMove(raw: Buffer): Promise<{ repo: FakeRepo; messageId: string }> {
  const repo = new FakeRepo();
  const stored = await repo.insertMessage({ senderCheck: null,
    accountId, mailboxId,
    canonical: { messageIdHeader: "f3@example.com", bodyHash: "h" },
    // DERIVED from the same bytes the pipeline will fingerprint, never a literal: a literal is a
    // second implementation of the key, and every one of them in this repo silently became a test
    // of the OLD format the moment `dedup_key` changed.
    dedupKey: await dedupKeyFor(raw),
    subject: "Roof detail", fromAddress: "anna@example.com", date: null,
    nativeLocator: SRC_LOC,
    flags: { no_ai: false, no_forward: false, no_kb: false, priority: false },
  });
  // Our move is outstanding: we want it in DST, we last saw it in SRC, and we set that intent.
  await repo.upsertFolderState(stored.id, {
    desiredFolder: DST, observedFolder: SRC, lastSetBy: "us",
  });
  return { repo, messageId: stored.id };
}

const create = (folder: string, raw: Buffer, ref: string): Change =>
  ({ type: "create", locator: { folder, ref }, raw });

async function cycle(repo: FakeRepo, change: Change) {
  const plan = await planChange(change, { repo, accountId, mailboxId });
  const res = await commitChange(plan, { repo, accountId, mailboxId, storageCap: UNMETERED_STORAGE_CAP });
  return { plan, res };
}

const instancesOf = (repo: FakeRepo, messageId: string) =>
  [...repo.instances.values()].filter((i) => i.messageId === messageId);

describe("a destination copy is not a completed move", () => {
  it("keeps the primary at the source and records the copy as a second instance", async () => {
    const raw = eml();
    const { repo, messageId } = await interruptedMove(raw);

    // The source did NOT vanish, so the worker recorded no disappearance and `correlateMoves` had
    // nothing to pair: this arrives as a plain create and the evidence is `appearance_only`.
    const { plan, res } = await cycle(repo, create(DST, raw, DST_LOC.ref));

    expect(res.outcome).toBe("own_move");
    expect(res.messageId).toBe(messageId);
    expect(plan.existing?.unexpungedSource, "the source whose expunge is still owed")
      .toEqual(SRC_LOC);

    // Never re-ingested — one logical message stays one row.
    expect(repo.rows.size).toBe(1);

    // THE PRIMARY STAYS AT THE SOURCE. It is the locator the retry is handed, and the only one the
    // surviving copy can be expunged from; repointing at the destination strands it addressable by
    // nothing.
    const inst = instancesOf(repo, messageId);
    const primary = inst.filter((i) => i.isPrimary);
    expect(primary).toHaveLength(1);
    expect(primary[0]!.folder).toBe(SRC);
    expect(primary[0]!.ref).toBe(SRC_LOC.ref);

    // And the copy is a locator we KNOW — so it is never re-fetched, and never rediscovered next
    // cycle as a stranger.
    const atDst = inst.filter((i) => i.folder === DST);
    expect(atDst, "the destination copy must be recorded, not ignored").toHaveLength(1);
    expect(atDst[0]!.isPrimary).toBe(false);
    expect(atDst[0]!.ref).toBe(DST_LOC.ref);

    // Two physical instances of one logical message is exactly what this column records.
    expect(repo.conflicts.has(messageId)).toBe(true);

    // Nothing was adopted and nobody is told anything moved: this is our own move, still in flight.
    expect(repo.audits.filter((a) => a.action === "adopt_external")).toHaveLength(0);
    expect(repo.changes.filter((c) => c.op === "move")).toHaveLength(0);
  });

  it("the conflict flag SURVIVES the folder-state write, not just precedes it", async () => {
    // `upsertFolderState` writes `conflict` false on every call. Raising the flag before the
    // switch runs would set a column that is cleared microseconds later — a green test over a row
    // that no longer carries the flag. This asserts the flag as it is AFTER the whole commit.
    const raw = eml();
    const { repo, messageId } = await interruptedMove(raw);
    await cycle(repo, create(DST, raw, DST_LOC.ref));

    expect(repo.conflicts.has(messageId)).toBe(true);
    const st = (await repo.getFolderState(messageId))!;
    expect(st.desiredFolder).toBe(DST);
    // PENDING, not converged: observed is still the source. Writing the destination here would
    // declare a completion nothing witnessed AND make `reconcileFolders` skip the row on its
    // `desired === observed` short-circuit, so the expunge would never be retried.
    expect(st.observedFolder).toBe(SRC);
  });

  it("re-observing the copy does not accumulate an instance per cycle", async () => {
    const raw = eml();
    const { repo, messageId } = await interruptedMove(raw);
    for (let i = 0; i < 3; i++) await cycle(repo, create(DST, raw, DST_LOC.ref));

    expect(repo.rows.size).toBe(1);
    const inst = instancesOf(repo, messageId);
    expect(inst, "one primary at the source, one record of the copy").toHaveLength(2);
    const primary = inst.filter((i) => i.isPrimary);
    expect(primary).toHaveLength(1);
    expect(primary[0]!.folder, "the retry target must not drift").toBe(SRC);
    // Still pending after three cycles: nothing about re-observing a copy completes a move.
    const st = (await repo.getFolderState(messageId))!;
    expect(st.observedFolder).toBe(SRC);
  });

  // ── THE TWO GENUINE COMPLETIONS MUST RECORD NOTHING ─────────────────────────────────────────

  it("a CORRELATED move records no stale source — the adapter paired the disappearance", async () => {
    const raw = eml();
    const { repo, messageId } = await interruptedMove(raw);
    // `correlateMoves` paired a vanished known UID with a re-appeared one.
    const { plan } = await cycle(repo, { type: "move", locator: DST_LOC, raw });

    expect(plan.existing?.unexpungedSource, "a real move leaves no second copy").toBeUndefined();
    expect(repo.conflicts.has(messageId)).toBe(false);
    expect(instancesOf(repo, messageId)).toHaveLength(1);
  });

  it("a VERIFIED ABSENCE records no stale source either", async () => {
    const raw = eml();
    const { repo, messageId } = await interruptedMove(raw);
    // The worker consumed `batch.deletes` and forgot the source instance — the only writer of a
    // disappearance, and the reason `primaryInstanceVanished` can answer true.
    await repo.forgetInstanceAt(mailboxId, SRC_LOC);

    const { plan } = await cycle(repo, create(DST, raw, DST_LOC.ref));

    expect(plan.existing?.unexpungedSource).toBeUndefined();
    expect(repo.conflicts.has(messageId)).toBe(false);
    const inst = instancesOf(repo, messageId);
    expect(inst).toHaveLength(1);
    expect(inst[0]!.folder).toBe(DST);
    expect(inst[0]!.isPrimary).toBe(true);
  });

  // ── THE PIN. READ THIS BEFORE CHANGING THE ASSERTION BELOW ──────────────────────────────────

  it("PIN: withholds completion, and may only converge again if imap.ts#move stops pre-checking", async () => {
    // This assertion is one half of a pair. Keeping the move pending is only safe while
    // `imap.ts#move` reads the destination before it writes, and the sequence if that pre-check is
    // ever removed is worth stating in full, because it is the reason this file used to assert the
    // OPPOSITE:
    //
    //   `reconcileFolders` retries `adapter.move(source, desired)`
    //     → without a pre-check the COPY branch copies AGAIN — the destination now holds two
    //       byte-identical messages, which by construction share a fingerprint
    //     → the fallback verify requires EXACTLY ONE match, finds two, raises `MoveVerifyError`
    //     → next cycle, the same, plus one more copy.
    //
    // One extra copy per cycle for ever, from a fault that produced a single duplicate. So: delete
    // the pre-check in `imap.ts#move` and this test must go back to expecting `{ type: "none" }`
    // and a converged row. Neither half of this behaviour is correct without the other.
    //
    // The pre-check is needed even WITH UIDPLUS — COPYUID names a new copy, it does not stop one
    // being made, and UIDPLUS and MOVE are separate capabilities.
    const raw = eml();
    const { repo, messageId } = await interruptedMove(raw);

    const { res } = await cycle(repo, create(DST, raw, DST_LOC.ref));

    // The move is still owed. `reconcileFolders` picks the row up again precisely because these
    // two disagree, and hands the SOURCE locator to a `move` that now converges instead of copying.
    expect(res.action, "a copy at the destination is not a completed move")
      .toEqual({ type: "move", to: DST });
    const st = (await repo.getFolderState(messageId))!;
    expect(st.desiredFolder).toBe(DST);
    expect(st.observedFolder).toBe(SRC);
    expect(st.desiredFolder).not.toBe(st.observedFolder);

    // AND NOBODY IS TOLD ANYTHING MOVED. The optimistic delta already shipped when the user asked
    // for the move; a second one here would be a change the client cannot reconcile.
    expect(repo.changes.filter((c) => c.op === "move")).toHaveLength(0);
  });
});
