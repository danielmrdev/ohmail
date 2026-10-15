import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { threads } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { makeTestDb } from "@trafficflow/db/testing";
import { DrizzleRepo } from "../src/adapters/drizzle-repo.js";
import { MAX_THREAD_PARTICIPANTS } from "../src/threading.js";

/**
 * FIND-OR-CREATE THE CONVERSATION, ON BOTH STORES — the ingest's first write.
 *
 * `upsertThread` runs before any message row is written, so on the device store it is not a
 * feature that degrades: it is the statement that stops the first drain. It failed there at once,
 * with `no such column: xmax` — the server's row-visibility column, which is how the server, and
 * only the server, answers "did I insert this row or find it".
 *
 * The two arms are therefore genuinely different code and not two spellings, and this file is the
 * control for each. The question both must answer identically is `created`: ingest records a
 * change-log row for a conversation it created and folds a message into one it found, so a wrong
 * answer is a duplicate conversation or a missing one, silently, in a statement that ran.
 *
 * ── WATCHED FAIL ──────────────────────────────────────────────────────────────────────────
 *
 * Removing the device arm's `SELECT` — so it always inserts — makes the second call report
 * `created: true` and leaves two rows for one header. Removing the branch entirely restores
 * `no such column: xmax` on the device store while the server run stays green.
 */
const ACCOUNT = "00000000-0000-4000-8000-0000000000bb";
const repoFor = async () => {
  const db = await makeTestDb();
  return { db, repo: new DrizzleRepo(db as never) };
};

const rowsForHeader = async (db: Awaited<ReturnType<typeof makeTestDb>>, header: string) =>
  db.select({ id: threads.id }).from(threads)
    .where(and(eq(threads.accountId, ACCOUNT), eq(threads.rootMessageIdHeader, header)));

const upsert = (repo: DrizzleRepo, header: string | null, subject = "Re: the roof") => repo.upsertThread({
  accountId: ACCOUNT,
  rootMessageIdHeader: header,
  subject,
  participants: [{ address: "someone@example.test", name: "Someone" }],
  lastMessageAt: new Date("2026-01-02T03:04:05.000Z"),
});

describe("the conversation anchor is found or created the same way on both stores", () => {
  it("creates once for a header and finds it every time after", async () => {
    const { db, repo } = await repoFor();

    const first = await upsert(repo, "<root-1@example.test>");
    expect(first.created).toBe(true);

    const second = await upsert(repo, "<root-1@example.test>");
    expect(second.created).toBe(false);
    // The SAME conversation, not merely another `created: false` — an arm that answered the flag
    // correctly while returning a different row would still split the thread.
    expect(second.id).toBe(first.id);
    expect(await rowsForHeader(db, "<root-1@example.test>")).toHaveLength(1);
  });

  it("keeps two headers apart", async () => {
    const { db, repo } = await repoFor();

    const a = await upsert(repo, "<root-a@example.test>");
    const b = await upsert(repo, "<root-b@example.test>");
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.id).not.toBe(b.id);
    expect(await rowsForHeader(db, "<root-a@example.test>")).toHaveLength(1);
    expect(await rowsForHeader(db, "<root-b@example.test>")).toHaveLength(1);
  });

  it("makes a singleton of every anchorless message, rather than folding them together", async () => {
    // NULLs are distinct in the unique index, so a message with no usable header anchors nothing
    // and each one is its own conversation. Both arms have to agree, and the device arm says it
    // as its own branch rather than leaning on `= NULL` never matching — the two look identical
    // and only one of them is a rule.
    const { repo } = await repoFor();

    const one = await upsert(repo, null);
    const two = await upsert(repo, null);
    expect(one.created).toBe(true);
    expect(two.created).toBe(true);
    expect(one.id).not.toBe(two.id);
  });

  it("works from INSIDE a transaction, where the handle carries no brand of its own", async () => {
    // The shape this is normally called in: ingest opens one transaction and persists the message,
    // the conversation and the change-log row together. A transaction is a different object built
    // by the query builder and inherits no dialect brand, so a branch that asks the HANDLE which
    // store it is on throws here — in the one place this method actually runs. Written as its own
    // case because the plain-handle cases above cannot see it: they never open a transaction, and
    // the failure is an exception rather than a wrong answer.
    const { db, repo } = await repoFor();

    const created = await repo.transaction((inTx) => upsert(inTx, "<root-tx@example.test>"));
    expect(created.created).toBe(true);

    const again = await repo.transaction((inTx) => upsert(inTx, "<root-tx@example.test>"));
    expect(again.created).toBe(false);
    expect(again.id).toBe(created.id);
    expect(await rowsForHeader(db, "<root-tx@example.test>")).toHaveLength(1);

    // AND the shape the ingest actually uses: a repository built DIRECTLY around the driver's
    // transaction object, with no dialect handed to it. `repo.transaction` passes its parent's
    // dialect down; direct construction does not, so only this half reaches the lookup that a
    // brandless transaction cannot answer.
    const direct = await db.transaction(async (tx) =>
      upsert(new DrizzleRepo(tx as never, dialect(db)), "<root-direct@example.test>"));
    expect(direct.created).toBe(true);
  });

  it("does not overwrite a renamed conversation when a later message joins it", async () => {
    // The no-op the server's conflict arm performs is a no-op on purpose: a rename is a person's
    // decision and ingest may not undo one. The device arm performs the same no-op, so both
    // leave the row in the same state.
    const { db, repo } = await repoFor();

    const created = await upsert(repo, "<root-2@example.test>", "The original subject");
    await db.update(threads).set({ subject: "What I renamed it to" })
      .where(eq(threads.id, created.id));

    await upsert(repo, "<root-2@example.test>", "Re: the original subject");

    const [after] = await db.select({ subject: threads.subject }).from(threads)
      .where(eq(threads.id, created.id));
    expect(after?.subject).toBe("What I renamed it to");
  });
});

/**
 * A CONVERSATION LISTS AT MOST {@link MAX_THREAD_PARTICIPANTS} PEOPLE, on both stores. Every message
 * folded in adds its sender and recipients, so one crafted To list, or fifty of them, grew the
 * jsonb toward the store's ceiling. Whoever is listed stays listed; past the bound nobody is added.
 */
describe("a conversation lists at most the bound of people, on both stores", () => {
  const people = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ address: `${p}${i}@example.test`, name: null }));
  const listed = async (db: Awaited<ReturnType<typeof makeTestDb>>, id: string): Promise<string[]> =>
    (((await db.select({ p: threads.participants }).from(threads).where(eq(threads.id, id)))[0]!.p ?? []) as Array<{ address: string }>)
      .map((x) => x.address);
  const start = (repo: DrizzleRepo, header: string, n: number) => repo.upsertThread({
    accountId: ACCOUNT, rootMessageIdHeader: header, subject: "Re: the roof",
    participants: people(n, "a"), lastMessageAt: new Date("2026-01-02T03:04:05.000Z"),
  });

  it("a message naming 150 people starts a conversation that lists the first 100", async () => {
    const { db, repo } = await repoFor();
    const created = await start(repo, "<wide@example.test>", MAX_THREAD_PARTICIPANTS + 50);
    expect(await listed(db, created.id)).toEqual(people(MAX_THREAD_PARTICIPANTS, "a").map((p) => p.address));
  });

  it("a joining message adds people up to the bound, and none past it", async () => {
    const { db, repo } = await repoFor();
    const created = await start(repo, "<joined@example.test>", 60);
    expect(await repo.mergeThreadMessage(created.id, { participants: people(60, "b"), lastMessageAt: null })).toBe(true);
    const full = await listed(db, created.id);
    expect(full).toEqual([...people(60, "a"), ...people(MAX_THREAD_PARTICIPANTS - 60, "b")].map((p) => p.address));
    expect(await repo.mergeThreadMessage(created.id, { participants: people(5, "c"), lastMessageAt: null }), "nothing moved").toBe(false);
    expect(await listed(db, created.id)).toEqual(full);
  });
});
