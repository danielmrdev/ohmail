import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { messages, messageStates, flagState } from "@trafficflow/db";
import { TriageService, MessageService } from "../src/index.js";
import { makeCtx, seedMessage, changesFor } from "./helpers.js";

/**
 * THE RESURFACE LIFECYCLE, SERVICE SIDE — the state machine the pin depends on.
 *
 * A resurface is ONE consequence: the state becomes `resurfaced` (the pin). It does NOT touch
 * read state — the artificial re-unread (+ the `\Seen`-removal intent) was removed by owner
 * ruling on 2026-08-26, after it made pins arrive bold whatever their real state and made reads
 * of pinned rows fail to stick. Placement in Resurface is the attention signal; the message
 * keeps its GENUINE read state.
 *
 * The pin is SPENT by exactly two verbs — a DELIBERATE read and a re-file — through EVERY route
 * that can perform them, because the first defect here was a route gap: only the batch read
 * cleared it. A GLANCE (`via: "glance"` — the dwell commit, the stream sweep) marks read WITHOUT
 * spending: the read sticks, the pin is answered only by dealing with the row.
 *
 * The worker's scheduled trigger (`bubbleUpPass`) is asserted in
 * `apps/worker/test/bubble-up-cron.test.ts`; this file owns the service-side triggers and spends.
 */

const triage = new TriageService();
const msgSvc = new MessageService();

async function msgRow(db: Awaited<ReturnType<typeof makeCtx>>["db"], id: string) {
  const [row] = await db.select().from(messages).where(eq(messages.id, id));
  return row!;
}
async function stateRow(db: Awaited<ReturnType<typeof makeCtx>>["db"], id: string) {
  const [row] = await db.select().from(messageStates).where(eq(messageStates.messageId, id));
  return row ?? null;
}
async function flagRow(db: Awaited<ReturnType<typeof makeCtx>>["db"], id: string) {
  const [row] = await db.select().from(flagState).where(eq(flagState.messageId, id));
  return row ?? null;
}

describe("resurfaceNow — the event pins and keeps the genuine read state", () => {
  it("a READ message stays read: no forced unread, no disowned reading, no \\Seen intent", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX", unread: false });
    const readAt = new Date("2026-07-20T10:00:00Z");
    await db.update(messages).set({ lastReadAt: readAt }).where(eq(messages.id, id));

    const dto = await triage.resurfaceNow(ctx, id);
    expect(dto.state).toBe("resurfaced");

    const m = await msgRow(db, id);
    expect(m.unread, "the pin must not fabricate an unread (owner ruling 2026-08-26)").toBe(false);
    expect(m.lastReadAt?.toISOString(), "the genuine reading stands").toBe(readAt.toISOString());

    // No IMAP round trip was queued: the mailbox's \Seen is genuine state and stays untouched.
    expect(await flagRow(db, id)).toBeNull();

    // The change pair still rides the same seam — state, then the message projection.
    const changes = await changesFor(db, accountId);
    expect(changes.map((c) => c.entityType)).toEqual(["message_state", "message"]);
  });

  it("an UNREAD message resurfaces unread — genuine state in the other direction", async () => {
    const { db, mailboxId, accountId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX", unread: true });
    await triage.resurfaceNow(ctx, id);
    const m = await msgRow(db, id);
    expect(m.unread).toBe(true);
    expect(await flagRow(db, id)).toBeNull();
  });

  it("does NOT touch read state on any other transition — bubbled_up snoozes as-is", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX", unread: false });

    await triage.bubbleUp(ctx, id, "2026-09-04T09:00:00.000Z");
    const m = await msgRow(db, id);
    expect(m.unread).toBe(false);             // snoozing is putting AWAY
    expect(await flagRow(db, id)).toBeNull(); // and no \Seen round trip was queued
  });
});

describe("the glance — via: \"glance\" marks read without spending the pin", () => {
  async function pinnedRead() {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX", unread: true });
    await db.insert(messageStates).values({ accountId, messageId: id, state: "resurfaced", bubbleUpAt: null });
    return { db, accountId, ctx, id };
  }

  it("the batch route: a glance read LANDS and the pin stands", async () => {
    const { db, ctx, id } = await pinnedRead();
    await msgSvc.markSeen(ctx, { ids: [id], unread: false, via: "glance" });
    const m = await msgRow(db, id);
    expect(m.unread, "reading a resurfaced message sticks like anywhere else").toBe(false);
    expect(m.lastReadAt).not.toBeNull();
    expect((await stateRow(db, id))!.state, "a glance does not spend the pin").toBe("resurfaced");
  });

  it("the single-message PATCH: same contract", async () => {
    const { db, ctx, id } = await pinnedRead();
    await msgSvc.patch(ctx, id, { unread: false, via: "glance" });
    expect((await msgRow(db, id)).unread).toBe(false);
    expect((await stateRow(db, id))!.state).toBe("resurfaced");
  });

  it("a glance carrying a FOLDER still spends — re-filing is dealing with the row", async () => {
    const { db, ctx, id } = await pinnedRead();
    await msgSvc.patch(ctx, id, { unread: false, folder: "ohmail/News", via: "glance" });
    expect((await stateRow(db, id))!.state).toBe("none");
  });

  it("an unknown via value is a 400, never a silently-deliberate read", async () => {
    const { ctx, id } = await pinnedRead();
    await expect(msgSvc.markSeen(ctx, { ids: [id], unread: false, via: "dwell" }))
      .rejects.toMatchObject({ httpStatus: 400, code: "validation_failed" });
    await expect(msgSvc.patch(ctx, id, { unread: false, via: "dwell" as never }))
      .rejects.toMatchObject({ httpStatus: 400, code: "validation_failed" });
  });
});

describe("spending the pin — every route that reads or re-files clears `resurfaced`", () => {
  async function pinned(o: { unread?: boolean } = {}) {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX", unread: o.unread ?? true });
    await db.insert(messageStates).values({ accountId, messageId: id, state: "resurfaced", bubbleUpAt: null });
    return { db, accountId, ctx, id };
  }

  it("the single-message PATCH marking read clears the pin — the route gap that stranded real mail", async () => {
    const { db, accountId, ctx, id } = await pinned();
    await msgSvc.patch(ctx, id, { unread: false });
    expect((await stateRow(db, id))!.state).toBe("none");
    // …and the clear reached the feed, so every mirror drops the pin on its next drain.
    const stateChanges = (await changesFor(db, accountId)).filter((c) => c.entityType === "message_state");
    expect(stateChanges).toHaveLength(1);
  });

  it("the single-message PATCH marking UNREAD leaves the pin standing", async () => {
    const { db, ctx, id } = await pinned({ unread: false });
    await msgSvc.patch(ctx, id, { unread: true });
    expect((await stateRow(db, id))!.state).toBe("resurfaced");
  });

  it("the batch route still clears it (the rule that always held)", async () => {
    const { db, ctx, id } = await pinned();
    await msgSvc.markSeen(ctx, { ids: [id], unread: false });
    expect((await stateRow(db, id))!.state).toBe("none");
  });

  it("re-filing clears the pin — move, and the PATCH folder arm", async () => {
    const a = await pinned();
    await msgSvc.move(a.ctx, a.id, { folder: "ohmail/News" });
    expect((await stateRow(a.db, a.id))!.state).toBe("none");

    const b = await pinned();
    await msgSvc.patch(b.ctx, b.id, { folder: "ohmail/News" });
    expect((await stateRow(b.db, b.id))!.state).toBe("none");
  });

  it("a `bubbled_up` schedule SURVIVES a re-file — only the pin is spendable", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX" });
    const when = new Date("2026-09-04T09:00:00Z");
    await db.insert(messageStates).values({ accountId, messageId: id, state: "bubbled_up", bubbleUpAt: when });
    await msgSvc.move(ctx, id, { folder: "ohmail/News" });
    const st = await stateRow(db, id);
    expect(st!.state).toBe("bubbled_up");     // the return the user asked for is still owed
    expect(st!.bubbleUpAt?.toISOString()).toBe(when.toISOString());
  });

  it("move answers a DTO whose triage already says none — the idempotent replay stores the truth", async () => {
    const { ctx, id } = await pinned();
    const { dto } = await msgSvc.move(ctx, id, { folder: "ohmail/News" });
    expect(dto.triage?.state).toBe("none");
  });
});
