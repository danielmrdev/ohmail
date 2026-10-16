import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { drafts, mailboxes, messages } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { DraftsService, SyncService } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

const svc = new DraftsService();
const sync = new SyncService();

async function setup() {
  const db = await makeTestDb();
  const A = randomUUID();
  const B = randomUUID();
  const [mbA] = await db.insert(mailboxes).values({ accountId: A, provider: "imap", address: "a@x-ch.example" }).returning();
  const [mbB] = await db.insert(mailboxes).values({ accountId: B, provider: "imap", address: "b@x-ch.example" }).returning();
  const now = new Date("2026-07-28T12:00:00Z");
  const ctxA: ServiceContext = { db, accountId: A, userId: null, now: () => now, requestId: "r" };
  const ctxB: ServiceContext = { db, accountId: B, userId: null, now: () => now, requestId: "r" };
  return { db, A, B, mbA: mbA!.id, mbB: mbB!.id, ctxA, ctxB };
}

describe("DraftsService — manual CRUD", () => {
  it("creates, gets, updates and deletes a draft", async () => {
    const { ctxA, mbA } = await setup();
    const { draft, seq } = await svc.create(ctxA, {
      mailboxId: mbA, subject: "Re: hi", body: "Thanks!", to: [{ name: null, address: "x@y.example" }],
    });
    expect(draft.status).toBe("draft");
    expect(draft.mailboxId).toBe(mbA);
    expect(draft.to).toEqual([{ name: null, address: "x@y.example" }]);
    expect(seq).toBeGreaterThan(0);

    const got = await svc.get(ctxA, draft.id);
    expect(got.body).toBe("Thanks!");

    const upd = await svc.update(ctxA, draft.id, { body: "Thanks a lot!", subject: "Re: hi again" });
    expect(upd.draft.body).toBe("Thanks a lot!");
    expect(upd.draft.subject).toBe("Re: hi again");
    expect(upd.seq).toBeGreaterThan(seq);

    const { seq: delSeq } = await svc.remove(ctxA, draft.id);
    expect(delSeq).toBeGreaterThan(upd.seq ?? Infinity);
    await expect(svc.get(ctxA, draft.id)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("create validates mailboxId ownership: a foreign/missing mailbox → 400", async () => {
    const { ctxA, mbB } = await setup();
    // mbB belongs to account B → not valid for A.
    await expect(svc.create(ctxA, { mailboxId: mbB })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(svc.create(ctxA, { mailboxId: randomUUID() })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(svc.create(ctxA, { mailboxId: "" })).rejects.toMatchObject({ httpStatus: 400 });
  });

  /**
   * THE REPLY TARGET IS A FOREIGN-KEY EDGE, AND IT WAS UNCHECKED.
   *
   * `drafts.in_reply_to_message_id` references `messages.id` and both write paths took the value
   * straight from the request body — while the `thread_id` written on the adjacent line has an
   * ownership read whose own comment says *"account isolation is absolute, so another account's
   * thread id is a 404, not a stored reference"*. One column obeyed it and the column beside it
   * did not.
   *
   * The damage is not a disclosure — the id is stored, never dereferenced into the draft — it is a
   * WRITE into another account's referential graph. The foreign key declares no `ON DELETE`, so it
   * RESTRICTS: a stranger's draft pointing at a victim's message makes deleting that message fail,
   * and erasing an account deletes its messages. One row the victim cannot see or remove holds
   * their erasure open.
   *
   * Watched red by removing `requireOwnedReplyTarget` from `create`: the draft is written and the
   * cross-account edge exists in the table.
   */
  it("a reply target belonging to another account is a 404, and no edge is written", async () => {
    const { db, ctxA, ctxB, mbA, mbB, B } = await setup();
    const dedup = `mid:${randomUUID()}`;
    const [victimMsg] = await db.insert(messages).values({
      accountId: B, mailboxId: mbB, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: "theirs", fromAddress: "s@x-ch.example", nativeLocator: { folder: "INBOX", ref: "1:1" },
    }).returning();

    await expect(
      svc.create(ctxA, { mailboxId: mbA, subject: "reply", inReplyToMessageId: victimMsg!.id }),
    ).rejects.toMatchObject({ httpStatus: 404 });

    // THE LOAD-BEARING ASSERTION: no row at all, so no foreign-key edge into B's graph.
    expect(await db.select().from(drafts), "the draft must not exist").toHaveLength(0);

    // The same on the update path, which is a separate write with its own copy of the check.
    const { draft } = await svc.create(ctxA, { mailboxId: mbA, subject: "mine" });
    await expect(
      svc.update(ctxA, draft.id, { inReplyToMessageId: victimMsg!.id }),
    ).rejects.toMatchObject({ httpStatus: 404 });
    const [after] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(after!.inReplyToMessageId, "the edge must not be stored by update either").toBeNull();

    // And the account's OWN message is still a legitimate reply target.
    const ownDedup = `mid:${randomUUID()}`;
    const [mine] = await db.insert(messages).values({
      accountId: ctxA.accountId, mailboxId: mbA, messageIdHeader: ownDedup,
      bodyHash: randomUUID(), dedupKey: ownDedup, subject: "mine", fromAddress: "s@x-ch.example",
      nativeLocator: { folder: "INBOX", ref: "1:2" },
    }).returning();
    const ok = await svc.create(ctxA, { mailboxId: mbA, subject: "ok", inReplyToMessageId: mine!.id });
    expect(ok.draft.id, "an owned reply target must still work").toBeTruthy();
  });

  it("cross-account get/update/remove → 404", async () => {
    const { ctxA, ctxB, mbA } = await setup();
    const { draft } = await svc.create(ctxA, { mailboxId: mbA, subject: "A only" });
    await expect(svc.get(ctxB, draft.id)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(svc.update(ctxB, draft.id, { body: "x" })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(svc.remove(ctxB, draft.id)).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("DraftsService — emits `draft` changes visible in /sync (no-tombstone proof)", () => {
  it("a created draft surfaces in /sync creates as a live entity — NOT a delete tombstone", async () => {
    const { ctxA, mbA } = await setup();
    const { draft } = await svc.create(ctxA, { mailboxId: mbA, subject: "Hello", body: "Body" });

    const resp = await sync.getChanges(ctxA, {});
    // The draft appears in creates with its materialized entity…
    const create = resp.changes.creates.find((c) => c.id === draft.id);
    expect(create).toBeDefined();
    expect(create!.type).toBe("draft");
    expect((create!.entity as { subject: string }).subject).toBe("Hello");
    expect((create!.entity as { status: string }).status).toBe("draft");
    // …and it did NOT vanish into deletes (the RC4 failure mode without materializeDraft).
    expect(resp.changes.deletes.find((d) => d.id === draft.id)).toBeUndefined();
  });

  it("update then delete surface as an update then a delete tombstone", async () => {
    const { ctxA, mbA } = await setup();
    const { draft, seq: createSeq } = await svc.create(ctxA, { mailboxId: mbA, subject: "v1" });
    await svc.update(ctxA, draft.id, { subject: "v2" });

    // Tail after the create: the update is a live `draft` update (not a tombstone).
    const afterCreate = await sync.getChanges(ctxA, { since: sync.encodeCursor(BigInt(createSeq)) });
    const upd = afterCreate.changes.updates.find((c) => c.id === draft.id);
    expect(upd).toBeDefined();
    expect((upd!.entity as { subject: string }).subject).toBe("v2");

    // After a real delete, the row is gone → materializeDraft returns null → tombstone.
    await svc.remove(ctxA, draft.id);
    const full = await sync.getChanges(ctxA, {});
    expect(full.changes.deletes.map((d) => d.id)).toContain(draft.id);
    expect(full.changes.creates.map((c) => c.id)).not.toContain(draft.id);
  });
});

/**
 * THE SENDING MAILBOX FOLLOWS THE PICK — while, and only while, the row is a draft.
 *
 * A draft's `mailboxId` used to be fixed at create, which froze the sending identity at the
 * FIRST AUTOSAVE: picking a different From after the first keystroke changed the screen and
 * nothing else, and the mail left under the identity the picker held when typing began. The
 * PATCH now moves it — validated exactly like create (owned, not disabled) — and the move is
 * refused with a 409 the moment the row has left `draft`, because a send in flight (or already
 * out) must not have its identity rewritten under it.
 */
describe("DraftsService — mailboxId is PATCHable while status is 'draft'", () => {
  it("PATCHing mailboxId re-homes a draft-status row to the other mailbox", async () => {
    const { db, ctxA, A, mbA } = await setup();
    const [mbA2] = await db.insert(mailboxes)
      .values({ accountId: A, provider: "imap", address: "a2@x-ch.example" }).returning();
    const { draft } = await svc.create(ctxA, { mailboxId: mbA, subject: "s", body: "b" });

    const upd = await svc.update(ctxA, draft.id, { mailboxId: mbA2!.id });
    expect(upd.draft.mailboxId).toBe(mbA2!.id);
    const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(row!.mailboxId).toBe(mbA2!.id);
  });

  it("a row past 'draft' refuses the move with 409 and keeps its mailbox", async () => {
    const { db, ctxA, A, mbA } = await setup();
    const [mbA2] = await db.insert(mailboxes)
      .values({ accountId: A, provider: "imap", address: "a2@x-ch.example" }).returning();
    for (const status of ["sending", "sent", "unverified"] as const) {
      const { draft } = await svc.create(ctxA, { mailboxId: mbA, subject: status, body: "b" });
      await db.update(drafts).set({ status }).where(eq(drafts.id, draft.id));
      await expect(svc.update(ctxA, draft.id, { mailboxId: mbA2!.id }))
        .rejects.toMatchObject({ httpStatus: 409 });
      const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
      expect(row!.mailboxId, `a '${status}' row was re-homed`).toBe(mbA);
    }
  });

  it("the move validates the target like create: foreign → 400, disabled → 400", async () => {
    const { db, ctxA, A, mbA, mbB } = await setup();
    const [dis] = await db.insert(mailboxes)
      .values({ accountId: A, provider: "imap", address: "dis@x-ch.example", status: "disabled" }).returning();
    const { draft } = await svc.create(ctxA, { mailboxId: mbA, subject: "s", body: "b" });
    await expect(svc.update(ctxA, draft.id, { mailboxId: mbB }))
      .rejects.toMatchObject({ httpStatus: 400 });
    await expect(svc.update(ctxA, draft.id, { mailboxId: dis!.id }))
      .rejects.toMatchObject({ httpStatus: 400 });
    const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(row!.mailboxId).toBe(mbA);
  });
});
