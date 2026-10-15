import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { folderState, mailboxes, organizerRequests } from "@trafficflow/db";
import { messageService } from "../src/index.js";
import { changesFor, makeCtx, seedMessage } from "./helpers.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  `PATCH /messages/:id { folder }` IS THE MOVE DOOR UNDER ANOTHER NAME
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `MessageService.move` and `MessageService.patch`'s `folder` branch write the SAME row the same
 * way — `folder_state.desired_folder` with `last_set_by: 'us'`, plus a `move` change — and the
 * reconciler turns either into a physical IMAP move. Mail 0083 gated `move` and `delete` and did
 * not gate this one, and `organizer-role-census.test.ts` could not see the gap: it asks whether a
 * FILE calls the refusal, and `message-service.ts` does, twice, at the other two doors.
 *
 * So a reader could move mail by spelling the request differently — two installs filing one
 * person's mail, reached through a route rather than through a sync loop, which is the exact thing
 * the lease exists to prevent. This file holds the third door to the same rule as the other two.
 */

async function readerCtx() {
  const ctx = await makeCtx();
  await ctx.db.update(mailboxes).set({
    organizerRole: "reader",
    organizerState: "held",
    organizedByCapabilities: "requests,moves",
    organizedByKind: "local",
    organizedByName: "mila-thinkpad",
  }).where(eq(mailboxes.id, ctx.mailboxId));
  return ctx;
}

describe("a reader's PATCH with a folder is the move door, and obeys the same rule", () => {
  it("PATCH { folder } on a capable reader queues a request and moves nothing here", async () => {
    const { db, accountId, mailboxId, ctx } = await readerCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });

    const result = await messageService.patch(ctx, id, { folder: "ohmail/News" });

    // The request exists…
    const rows = await db.select().from(organizerRequests)
      .where(eq(organizerRequests.accountId, accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mailboxId, kind: "message.move", state: "pending" });
    expect(rows[0]!.payload).toMatchObject({ destination: "reads" });
    expect(result.pending).toMatchObject({ holder: { name: "mila-thinkpad" } });

    // …and NOTHING moved locally, which is the half a wrong fix would lose.
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs).toMatchObject({ desiredFolder: "INBOX", observedFolder: "INBOX" });
    expect((await changesFor(db, accountId)).map((c) => c.op)).not.toContain("move");
  });

  it("PATCH { unread } alone still works on a reader — marking read is its one write verb", async () => {
    /* THE POSITIVE CONTROL, and it is the one that matters here: `\Seen` is the single IMAP write
     * a reader is allowed, `reconcileFlags` runs on a reader cycle deliberately, and a fix that
     * gated the whole PATCH door instead of its `folder` branch would take that away — the reader
     * could no longer mark its own mail read, with every refusal test above still green. */
    const { db, accountId, mailboxId, ctx } = await readerCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", unread: true });

    const result = await messageService.patch(ctx, id, { unread: false });
    expect(result.pending).toBeUndefined();
    expect(result.dto.unread).toBe(false);
    expect(await db.select().from(organizerRequests)
      .where(eq(organizerRequests.accountId, accountId))).toEqual([]);
  });

  it("PATCH { unread, folder } on a reader marks read locally AND queues only the move", async () => {
    // The two halves are decided separately, because they are separately permitted.
    const { db, accountId, mailboxId, ctx } = await readerCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", unread: true });

    const result = await messageService.patch(ctx, id, { unread: false, folder: "ohmail/News" });
    expect(result.dto.unread).toBe(false);
    expect(result.pending).not.toBeUndefined();

    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs!.desiredFolder).toBe("INBOX");
    expect((await changesFor(db, accountId)).map((c) => c.op)).not.toContain("move");
  });

  it("PATCH { folder } against a `requests`-only holder is 409, and queues nothing", async () => {
    const { db, accountId, mailboxId, ctx } = await readerCtx();
    await db.update(mailboxes).set({ organizedByCapabilities: "requests" })
      .where(eq(mailboxes.id, mailboxId));
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });

    await expect(messageService.patch(ctx, id, { folder: "ohmail/News" })).rejects.toMatchObject({
      code: "organized_elsewhere", details: { reason: "organizer_outdated" },
    });
    expect(await db.select().from(organizerRequests)
      .where(eq(organizerRequests.accountId, accountId))).toEqual([]);
  });

  it("an ORGANIZER's PATCH { folder } is unchanged — it files, as it always did", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });

    const result = await messageService.patch(ctx, id, { folder: "ohmail/News" });
    expect(result.pending).toBeUndefined();
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs).toMatchObject({ desiredFolder: "ohmail/News", lastSetBy: "us" });
    expect((await changesFor(db, accountId)).map((c) => c.op)).toContain("move");
  });
});
