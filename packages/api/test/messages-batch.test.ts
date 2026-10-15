import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { changeLog, flagState, messages } from "@trafficflow/db";
import { and, eq } from "drizzle-orm";
import { MARK_SEEN_MAX_IDS } from "@trafficflow/services";
import { makeDeps, seedSession, seedMailbox, seedMessage, req, FIXED_NOW } from "./helpers.js";

/**
 * `PATCH /messages { ids, unread }` — the batch read-state route.
 *
 * The four properties under test are the four the route's doc comment claims, and each one is
 * written so that removing the mechanism makes it red:
 *
 *  · ONE transaction — a foreign id rolls back every OTHER message in the same request.
 *  · Account scoping is a REJECTION, not a filter — 404, and indistinguishable from "unknown".
 *  · ONE `change_log` row per message, so the delta feed can name each entity.
 *  · `flag_state.desired_seen` per message and NO IMAP — the worker owns the network write.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

const patchBatch = (token: string, body: unknown, headers?: Record<string, string>): Request =>
  req("PATCH", "/messages", { bearer: token, body: JSON.stringify(body), ...(headers ? { headers } : {}) });

describe("PATCH /messages — the batch read-state route", () => {
  it("flips every id, emits ONE change per message, and writes flag_state desired (no IMAP)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const a = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", unread: true });
    const b = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "ohmail/Receipts", unread: true });

    const res = await H(patchBatch(s.token, { ids: [a.id, b.id], unread: false }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((m: { id: string }) => m.id).sort()).toEqual([a.id, b.id].sort());
    expect(body.items.every((m: { unread: boolean }) => m.unread === false)).toBe(true);
    expect(res.headers.get("x-sync-seq")).toBeTruthy();

    // The read model moved — across TWO different folders, which is the whole point of a
    // folder-agnostic mutation.
    const rows = await db.select({ id: messages.id, unread: messages.unread }).from(messages)
      .where(eq(messages.accountId, s.accountId));
    expect(rows.every((r) => r.unread === false)).toBe(true);

    // One delta per message, no more and no fewer.
    for (const id of [a.id, b.id]) {
      const changes = await db.select().from(changeLog)
        .where(and(eq(changeLog.accountId, s.accountId), eq(changeLog.entityId, id), eq(changeLog.op, "update")));
      expect(changes, `one update change for ${id}`).toHaveLength(1);
    }

    // The DESIRED state the worker will push. `observed_seen` is the pre-request read model
    // (both were unread ⇒ observed false), so both rows are pending an IMAP write.
    const flags = await db.select().from(flagState);
    expect(flags).toHaveLength(2);
    for (const f of flags) {
      expect(f).toMatchObject({
        desiredSeen: true, observedSeen: false, lastSetBy: "us", reconcileStatus: "pending",
      });
    }
  });

  it("marking UNREAD again is the same route with the other value", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", unread: false });

    const res = await H(patchBatch(s.token, { ids: [m.id], unread: true }), deps);
    expect(res.status).toBe(200);
    const [row] = await db.select().from(flagState).where(eq(flagState.messageId, m.id));
    expect(row).toMatchObject({ desiredSeen: false, observedSeen: true, reconcileStatus: "pending" });
  });

  it("a NO-OP click queues no IMAP work — desired already equals observed ⇒ reconciled", async () => {
    // Nothing to push, so the row must not sit in the worker's pending list forever burning a
    // STORE per cycle for a flag the server already has.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", unread: false });

    expect((await H(patchBatch(s.token, { ids: [m.id], unread: false }), deps)).status).toBe(200);
    const [row] = await db.select().from(flagState).where(eq(flagState.messageId, m.id));
    expect(row).toMatchObject({ desiredSeen: true, observedSeen: true, reconcileStatus: "reconciled" });
  });

  it("a duplicated id is ONE update and ONE change", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", unread: true });

    const res = await H(patchBatch(s.token, { ids: [m.id, m.id, m.id], unread: false }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(1);
    const changes = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, s.accountId), eq(changeLog.entityId, m.id)));
    expect(changes).toHaveLength(1);
  });
});

describe("PATCH /messages — account scoping is a rejection, not a filter", () => {
  it("ONE foreign id ⇒ 404 AND a full rollback: the account's own messages are untouched", async () => {
    // THE GUARD. Delete `eq(messages.accountId, ctx.accountId)` from the ownership SELECT in
    // `MessageService.markSeen` and this goes red twice over: the request answers 200, and the
    // victim's row flips. A silent skip would be almost as bad — the response length would tell
    // a prober which ids exist in someone else's account (the "Account isolation is absolute, and it binds staff too" invariant).
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });

    const mine = await seedMessage(db, { accountId: owner.accountId, folder: "INBOX", unread: true });
    const theirs = await seedMessage(db, { accountId: other.accountId, folder: "INBOX", unread: true });

    const res = await H(patchBatch(owner.token, { ids: [mine.id, theirs.id], unread: false }), deps);
    expect(res.status).toBe(404);

    // FULL ROLLBACK: the legitimate half of the batch did not land either.
    const [mineRow] = await db.select().from(messages).where(eq(messages.id, mine.id));
    expect(mineRow!.unread, "the account's own message must not have been flipped").toBe(true);
    const [theirRow] = await db.select().from(messages).where(eq(messages.id, theirs.id));
    expect(theirRow!.unread, "the victim's message must not have been touched").toBe(true);

    expect(await db.select().from(flagState)).toHaveLength(0);
    expect(await db.select().from(changeLog)
      .where(eq(changeLog.accountId, owner.accountId))).toHaveLength(0);
  });

  it("an UNKNOWN id is the same 404 as a foreign one — indistinguishable", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", unread: true });
    const ghost = "00000000-0000-4000-8000-000000000000";

    const res = await H(patchBatch(s.token, { ids: [m.id, ghost], unread: false }), deps);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });
});

describe("PATCH /messages — the cap and the validation floor", () => {
  it(`${MARK_SEEN_MAX_IDS + 1} ids are refused with 413; exactly ${MARK_SEEN_MAX_IDS} is accepted`, async () => {
    // The cap is what keeps one request from holding the `account_sync_state` row lock — and
    // therefore every other mutation on the account — for the length of an unbounded batch.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });

    const over = Array.from({ length: MARK_SEEN_MAX_IDS + 1 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const res = await H(patchBatch(s.token, { ids: over, unread: false }), deps);
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("payload_too_large");
    // Refused BEFORE any lookup: no rows, no changes.
    expect(await db.select().from(changeLog)).toHaveLength(0);

    // …and the boundary itself is legal. Real messages, so this also proves the cap is not
    // secretly off by one against a full-size batch.
    const ids: string[] = [];
    for (let i = 0; i < MARK_SEEN_MAX_IDS; i++) {
      ids.push((await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", unread: true })).id);
    }
    const ok = await H(patchBatch(s.token, { ids, unread: false }), deps);
    expect(ok.status).toBe(200);
    expect((await ok.json()).items).toHaveLength(MARK_SEEN_MAX_IDS);
  }, 60_000);

  it("missing/!boolean unread, empty ids, non-array ids and a malformed id are all 400", async () => {
    // The malformed-id case is not pedantry: an unvalidated string reaches Postgres as a uuid
    // comparison and raises 22P02, which surfaces as a 500 for what is plainly a bad request.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });

    const bad = [
      { ids: [m.id] },
      { ids: [m.id], unread: "false" },
      { ids: [], unread: false },
      { ids: m.id, unread: false },
      { ids: [m.id, "not-a-uuid"], unread: false },
      { ids: [42], unread: false },
    ];
    for (const body of bad) {
      const res = await H(patchBatch(s.token, body), deps);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("an unauthenticated caller gets 401, not a 400 about its body", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("PATCH", "/messages", { body: JSON.stringify({ ids: [], unread: false }) }), deps);
    expect(res.status).toBe(401);
  });
});

describe("PATCH /messages vs PATCH /messages/:id — the router keeps them apart", () => {
  it("the batch route does not swallow the single-message route", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", unread: true });

    // Same method, different segment counts — `matchRoute` compares lengths first.
    const single = await H(req("PATCH", `/messages/${m.id}`, { bearer: s.token, body: JSON.stringify({ unread: false }) }), deps);
    expect(single.status).toBe(200);
    expect((await single.json()).unread).toBe(false);

    // …and the single route now records the intent too, which is what a review found missing: it used
    // to write `messages.unread` and stop, so the flag never reached the mailbox.
    const [row] = await db.select().from(flagState).where(eq(flagState.messageId, m.id));
    expect(row).toMatchObject({ desiredSeen: true, observedSeen: false, lastSetBy: "us", reconcileStatus: "pending" });
  });
});
