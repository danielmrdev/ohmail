import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { drafts, messages, threadNotes, threads } from "@trafficflow/db";
import { and, eq } from "drizzle-orm";
import { makeDeps, seedSession, seedMailbox, seedMessage, seedThread, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

async function syncBuckets(deps: ApiDeps, token: string): Promise<{ updates: string[]; deletes: string[] }> {
  const res = await H(req("GET", "/sync?since=0", { bearer: token }), deps);
  const b = await res.json();
  return {
    updates: b.changes.updates.map((c: { id: string }) => c.id),
    deletes: b.changes.deletes.map((c: { id: string }) => c.id),
  };
}

describe("threads", () => {
  it("GET returns the thread with its messageIds", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const threadId = await seedThread(db, { accountId: s.accountId, subject: "Trip" });
    const m1 = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, threadId, folder: "INBOX" });

    const res = await H(req("GET", `/threads/${threadId}`, { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const dto = await res.json();
    expect(dto.subject).toBe("Trip");
    expect(dto.messageIds).toContain(m1.id);
  });

  it("PATCH muted persists + emits a thread update change", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const threadId = await seedThread(db, { accountId: s.accountId });

    const res = await H(req("PATCH", `/threads/${threadId}`, { bearer: s.token, body: JSON.stringify({ muted: true }) }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).muted).toBe(true);
    expect((await syncBuckets(deps, s.token)).updates).toContain(threadId);
  });

  it("rename changes the subject + emits a thread update change", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const threadId = await seedThread(db, { accountId: s.accountId, subject: "old" });

    const res = await H(req("POST", `/threads/${threadId}/rename`, { bearer: s.token, body: JSON.stringify({ subject: "new subject" }) }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).subject).toBe("new subject");
    const [row] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(row.subject).toBe("new subject");
    expect((await syncBuckets(deps, s.token)).updates).toContain(threadId);
  });

  it("merge reassigns messages to the target, deletes + tombstones the merged threads", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const target = await seedThread(db, { accountId: s.accountId, subject: "target" });
    const other = await seedThread(db, { accountId: s.accountId, subject: "other" });
    const mt = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, threadId: target, folder: "INBOX" });
    const mo = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, threadId: other, folder: "INBOX" });

    const res = await H(req("POST", "/threads/merge", { bearer: s.token, body: JSON.stringify({ threadIds: [target, other], subject: "merged" }) }), deps);
    expect(res.status).toBe(200);
    const dto = await res.json();
    expect(dto.id).toBe(target);
    expect(dto.subject).toBe("merged");
    expect(dto.messageIds.sort()).toEqual([mt.id, mo.id].sort());

    // The formerly-`other` message now points at the target.
    const [moved] = await db.select().from(messages).where(eq(messages.id, mo.id));
    expect(moved.threadId).toBe(target);
    // The merged-away thread is gone.
    const gone = await db.select().from(threads).where(and(eq(threads.id, other), eq(threads.accountId, s.accountId)));
    expect(gone).toHaveLength(0);

    const buckets = await syncBuckets(deps, s.token);
    expect(buckets.updates).toContain(target);   // target update + moved message update
    expect(buckets.updates).toContain(mo.id);
    expect(buckets.deletes).toContain(other);     // merged thread tombstoned
  });

  it("merge survives a note, a draft and a tombstoned message on the merged thread (23503 fix)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const target = await seedThread(db, { accountId: s.accountId, subject: "target" });
    const other = await seedThread(db, { accountId: s.accountId, subject: "other" });
    await seedMessage(db, { accountId: s.accountId, mailboxId: mb, threadId: target, folder: "INBOX" });
    const dead = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, threadId: other, folder: "INBOX" });
    await db.update(messages).set({ deletedAt: FIXED_NOW }).where(eq(messages.id, dead.id));
    // The two OTHER tables that FK a thread: before the fix this merge died on 23503 and 500ed.
    const [note] = await db.insert(threadNotes).values({
      accountId: s.accountId, threadId: other, body: "keep this",
    }).returning({ id: threadNotes.id });
    const [draft] = await db.insert(drafts).values({
      accountId: s.accountId, mailboxId: mb, threadId: other, subject: "Re: other",
    }).returning({ id: drafts.id });

    const res = await H(req("POST", "/threads/merge", { bearer: s.token, body: JSON.stringify({ threadIds: [target, other] }) }), deps);
    expect(res.status).toBe(200);

    // Note and draft follow the conversation onto the survivor.
    const [n] = await db.select({ threadId: threadNotes.threadId }).from(threadNotes).where(eq(threadNotes.id, note!.id));
    expect(n!.threadId).toBe(target);
    const [d] = await db.select({ threadId: drafts.threadId }).from(drafts).where(eq(drafts.id, draft!.id));
    expect(d!.threadId).toBe(target);

    // The tombstoned message moved (the FK demands it) but was NOT announced: an update for a
    // deleted entity materializes without consulting deleted_at, and would resurrect the mail.
    const [t] = await db.select({ threadId: messages.threadId, deletedAt: messages.deletedAt })
      .from(messages).where(eq(messages.id, dead.id));
    expect(t!.threadId).toBe(target);
    expect(t!.deletedAt).not.toBeNull();
    const buckets = await syncBuckets(deps, s.token);
    expect(buckets.updates).not.toContain(dead.id);
    expect(buckets.updates).toContain(draft!.id);   // drafts are mirrored, so the repoint is told
  });

  /**
   * A merge DELETES the threads it absorbs, so the second arrival of one
   * press names ids that are gone and the ownership gate answers 404 — the one wrong answer this
   * route could give, because a lost response and a rejection then read identically. The key is
   * claimed inside the merge transaction, so the retry replays the first answer verbatim.
   */
  it("a retry under the same key replays the merge instead of answering 404", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const target = await seedThread(db, { accountId: s.accountId, subject: "target" });
    const other = await seedThread(db, { accountId: s.accountId, subject: "other" });
    await seedMessage(db, { accountId: s.accountId, mailboxId: mb, threadId: target, folder: "INBOX" });
    const mo = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, threadId: other, folder: "INBOX" });

    const press = (): Promise<Response> => H(req("POST", "/threads/merge", {
      bearer: s.token, headers: { "idempotency-key": "merge-1" },
      body: JSON.stringify({ threadIds: [target, other], subject: "merged" }),
    }), deps);

    const first = await press();
    expect(first.status).toBe(200);
    const firstDto = await first.json();

    const retry = await press();
    expect(retry.status).toBe(200);
    expect(await retry.json(), "the retry did not replay the first answer").toEqual(firstDto);

    // AND THE MERGE HAPPENED ONCE. A second run would emit a second set of change rows; the
    // message moved once and the absorbed thread is gone exactly once.
    const [moved] = await db.select().from(messages).where(eq(messages.id, mo.id));
    expect(moved.threadId).toBe(target);
    expect(await db.select().from(threads).where(eq(threads.accountId, s.accountId))).toHaveLength(1);
  });

  /** A DIFFERENT merge under the same key is the reuse the middleware refuses, not a replay. */
  it("the same key with a different request → 409", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const a = await seedThread(db, { accountId: s.accountId });
    const b = await seedThread(db, { accountId: s.accountId });
    const c = await seedThread(db, { accountId: s.accountId });
    const d = await seedThread(db, { accountId: s.accountId });

    const merge = (ids: string[]): Promise<Response> => H(req("POST", "/threads/merge", {
      bearer: s.token, headers: { "idempotency-key": "merge-2" },
      body: JSON.stringify({ threadIds: ids }),
    }), deps);

    expect((await merge([a, b])).status).toBe(200);
    expect((await merge([c, d])).status).toBe(409);
    // The second pair is untouched: four threads minus the one the first merge absorbed.
    expect(await db.select().from(threads).where(eq(threads.accountId, s.accountId))).toHaveLength(3);
  });

  it("cross-account → 404 for get / patch / rename / merge", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const t1 = await seedThread(db, { accountId: owner.accountId });
    const t2 = await seedThread(db, { accountId: owner.accountId });

    expect((await H(req("GET", `/threads/${t1}`, { bearer: other.token }), deps)).status).toBe(404);
    expect((await H(req("PATCH", `/threads/${t1}`, { bearer: other.token, body: JSON.stringify({ muted: true }) }), deps)).status).toBe(404);
    expect((await H(req("POST", `/threads/${t1}/rename`, { bearer: other.token, body: JSON.stringify({ subject: "x" }) }), deps)).status).toBe(404);
    // A merge naming another account's thread → 404 (whole op rejected).
    expect((await H(req("POST", "/threads/merge", { bearer: other.token, body: JSON.stringify({ threadIds: [t1, t2] }) }), deps)).status).toBe(404);
    // Owner's threads untouched.
    expect((await H(req("GET", `/threads/${t1}`, { bearer: owner.token }), deps)).status).toBe(200);
  });
});
