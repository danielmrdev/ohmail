import { describe, it, expect } from "vitest";
import { planChange, commitChange, UNMETERED_STORAGE_CAP } from "../src/pipeline.js";
import { FakeRepo, dedupKeyFor } from "./fakes.js";
import type { Change, NativeLocator } from "../src/ports.js";

/**
 * A RE-INGEST MAY NOT RESTORE THE INTENT A PERSON JUST REPLACED.
 *
 * `planChange` reads `folder_state` outside the commit transaction and `commitChange` writes it
 * back later. File the message somewhere else in between — a press that succeeded — and the
 * planned pair was written over it, `none` marking the stale desire RECONCILED: the accepted
 * placement cancelled, and the row recording that it agreed with the server about it. The press
 * is an ordinary `upsertFolderState`, which is what every filing door commits.
 */
const SRC = "INBOX";
const DST = "ohmail/News";
const PRESSED = "ohmail/Receipts";
const SRC_LOC: NativeLocator = { folder: SRC, ref: "1:10" };
const DST_LOC: NativeLocator = { folder: DST, ref: "7:41" };
const accountId = "acct-1";
const mailboxId = "mb-1";

const raw = Buffer.from([
  "Message-ID: <reingest@example.com>",
  "From: anna@example.com",
  "To: owner@example.com",
  "Subject: Roof detail",
  "Content-Type: text/plain; charset=utf-8",
  "", "the ridge beam is 240mm",
].join("\r\n"));

/**
 * The state a pending move leaves: the row wants DST, last saw SRC. `landed` forgets the source
 * instance, which is what makes the next observation a COMPLETION (`none`) rather than the
 * unexpunged-source re-assert (`move`) — the two arms this file measures.
 */
async function pendingMove(landed: boolean): Promise<{ repo: FakeRepo; messageId: string }> {
  const repo = new FakeRepo();
  const stored = await repo.insertMessage({ senderCheck: null,
    accountId, mailboxId,
    canonical: { messageIdHeader: "reingest@example.com", bodyHash: "h" },
    dedupKey: await dedupKeyFor(raw),
    subject: "Roof detail", fromAddress: "anna@example.com", date: null,
    nativeLocator: SRC_LOC,
    flags: { no_ai: false, no_forward: false, no_kb: false, priority: false },
  });
  await repo.upsertFolderState(stored.id, {
    desiredFolder: DST, observedFolder: SRC, lastSetBy: "us",
  });
  if (landed) await repo.forgetInstanceAt(mailboxId, SRC_LOC);
  return { repo, messageId: stored.id };
}

const arrival: Change = { type: "create", locator: DST_LOC, raw };
const plan = (repo: FakeRepo) =>
  planChange(arrival, { repo, accountId, mailboxId, readerMode: false });
const commit = (repo: FakeRepo, p: Awaited<ReturnType<typeof plan>>) =>
  commitChange(p, { repo, accountId, mailboxId, storageCap: UNMETERED_STORAGE_CAP });
/** The person files the message somewhere else, and that press commits. */
const press = (repo: FakeRepo, messageId: string, observed: string): void => {
  repo.folder.set(messageId, { desiredFolder: PRESSED, observedFolder: observed, lastSetBy: "us" });
};

describe("a re-ingest checks the intent it planned against before it writes", () => {
  it("THE PRESS STANDS — the completion does not restore the desire, and reconciles nothing to it", async () => {
    const { repo, messageId } = await pendingMove(true);
    const p = await plan(repo);
    expect(p.existing?.action.type).toBe("none");

    press(repo, messageId, SRC);
    await commit(repo, p);

    const row = repo.folder.get(messageId)!;
    // THE CLAIM. Before the fix both columns read `ohmail/News`: the press cancelled, the pair
    // converged, and nothing was left pending to carry the person's placement out.
    expect(row.desiredFolder).toBe(PRESSED);
    // The arrival is a fresh physical fact and IS recorded — the message really is in Reads — so
    // the row is pending toward Receipts and the reconciler plans again from the person's own
    // placement rather than fighting it.
    expect(row.observedFolder).toBe(DST);
    expect(row.desiredFolder === row.observedFolder, "a stale plan may not claim convergence")
      .toBe(false);
  });

  it("THE POSITIVE CONTROL — an ordinary completion with no press still heals", async () => {
    const { repo, messageId } = await pendingMove(true);
    await commit(repo, await plan(repo));

    const row = repo.folder.get(messageId)!;
    expect(row.desiredFolder).toBe(DST);
    expect(row.observedFolder, "the move's own completion still lands").toBe(DST);
  });

  it("THE PENDING MOVE — a press is not replaced by the re-asserted plan either", async () => {
    const { repo, messageId } = await pendingMove(false);
    const p = await plan(repo);
    expect(p.existing?.action.type).toBe("move");

    press(repo, messageId, SRC);
    await commit(repo, p);

    const row = repo.folder.get(messageId)!;
    expect(row.desiredFolder, "the mail would have been moved where the older decision said")
      .toBe(PRESSED);
    expect(row.observedFolder).toBe(SRC);
  });

  it("THE RE-ASSERT'S POSITIVE CONTROL — with no press the pending pair is written back", async () => {
    const { repo, messageId } = await pendingMove(false);
    await commit(repo, await plan(repo));

    const row = repo.folder.get(messageId)!;
    expect(row.desiredFolder).toBe(DST);
    expect(row.observedFolder).toBe(SRC);
  });

  it("THE RE-PLAN RUNS ONCE — one conditional write, no retry and no loop", async () => {
    const { repo, messageId } = await pendingMove(true);
    const p = await plan(repo);
    press(repo, messageId, SRC);

    let completions = 0;
    let blind = 0;
    const complete = repo.completeFolderState.bind(repo);
    const upsert = repo.upsertFolderState.bind(repo);
    repo.completeFolderState = async (id, c) => { completions++; return complete(id, c); };
    repo.upsertFolderState = async (id, s) => { blind++; return upsert(id, s); };

    await commit(repo, p);

    expect(completions, "one statement, one outcome").toBe(1);
    expect(blind, "a refused completion is never retried blindly").toBe(0);
  });

  it("NO ROW IS NOT A NEWER INTENT — a message with no placement row still gets one", async () => {
    const { repo, messageId } = await pendingMove(true);
    const p = await plan(repo);
    repo.folder.delete(messageId);

    await commit(repo, p);

    const row = repo.folder.get(messageId);
    expect(row, "nothing was preserved, so the plan's own pair is written").toBeDefined();
    expect(row!.desiredFolder).toBe(DST);
    expect(row!.observedFolder).toBe(DST);
  });
});

/* ── MUTATIONS WATCHED RED, EACH RESTORED FROM A PRISTINE COPY AND PROVED BY `cmp` ───────────
 *  · the `none` arm's `completeFolderState` swapped back for the unconditional `upsertFolderState`
 *    (the defect) ⇒ THE PRESS STANDS red at `ohmail/News` where the person pressed Receipts, and
 *    the once-only arm red on the write count; both positive controls green.
 *  · the `move` arm's comparison removed ⇒ THE PENDING MOVE red the same way.
 */
