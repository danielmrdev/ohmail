import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { messages, messageStates } from "@trafficflow/db";
import { TriageService, ServiceError } from "../src/index.js";
import { makeCtx, seedMessage, changesFor } from "./helpers.js";

const svc = new TriageService();

describe("TriageService — states + views", () => {
  it("setState upserts message_states and emits a message_state update change", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX" });

    const dto = await svc.setState(ctx, id, { state: "reply_later" });
    expect(dto.state).toBe("reply_later");
    expect(dto.messageId).toBe(id);

    const changes = await changesFor(db, accountId);
    const upd = changes.filter((c) => c.entityType === "message_state" && c.op === "update");
    expect(upd).toHaveLength(1);

    // Re-setting the same message updates in place (one row) and emits another change.
    await svc.setState(ctx, id, { state: "set_aside" });
    const rows = await db.select().from(messageStates).where(eq(messageStates.messageId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("set_aside");
    const changes2 = await changesFor(db, accountId);
    expect(changes2.filter((c) => c.entityType === "message_state").length).toBe(2);
  });

  it("bubbled_up REQUIRES bubbleUpAt (400 otherwise) and stores the resurface time", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX" });

    await expect(svc.setState(ctx, id, { state: "bubbled_up" })).rejects.toMatchObject({
      constructor: ServiceError, httpStatus: 400,
    });

    const when = "2026-08-01T09:00:00.000Z";
    const dto = await svc.bubbleUp(ctx, id, when);
    expect(dto.state).toBe("bubbled_up");
    expect(dto.bubbleUpAt).toBe(when);
  });

  it("mute / clear transitions also flow through the change_log", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX" });
    await svc.mute(ctx, id);
    await svc.clear(ctx, id);
    const rows = await db.select().from(messageStates).where(eq(messageStates.messageId, id));
    expect(rows[0].state).toBe("none");
    expect((await changesFor(db, accountId)).filter((c) => c.entityType === "message_state").length).toBe(2);
  });

  it("cross-account message → 404", async () => {
    const { ctx } = await makeCtx();
    await expect(svc.setState(ctx, "00000000-0000-0000-0000-000000000000", { state: "reply_later" }))
      .rejects.toMatchObject({ httpStatus: 404 });
  });

  it("listByState returns the pile; focusReply reads reply_later; powerThrough reads unread Imbox", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const a = await seedMessage(db, accountId, mailboxId, { from: "a@ex.example", folder: "INBOX", desired: "INBOX", unread: true });
    const b = await seedMessage(db, accountId, mailboxId, { from: "b@ex.example", folder: "INBOX", desired: "INBOX", unread: true });
    await seedMessage(db, accountId, mailboxId, { from: "c@ex.example", folder: "INBOX", desired: "INBOX", unread: false });

    await svc.setState(ctx, a, { state: "reply_later" });

    const pile = await svc.listByState(ctx, "reply_later", {});
    expect(pile.items.map((m) => m.id)).toEqual([a]);

    const focus = await svc.focusReply(ctx);
    expect(focus.remaining).toBe(1);
    expect(focus.items[0].message.id).toBe(a);
    expect(focus.items[0].draft).toBeNull();

    /* POWER THROUGH IS THE "NEW FOR YOU" GROUP, AND `a` IS NOT IN IT ANY MORE.
       This case used to assert `remaining: 2` with `a` among the answers — the exact defect
       the power-through-scope row names, written down as expected behaviour: `a` was parked in
       Answer Later two statements above, the screen holds parked mail out of all three Ohbox
       groups, and the view served and counted it anyway. `b` alone is the group, so there is
       no second row and no cursor. The assertion is exact rather than `toContain`: with one
       row left, "either of these" would pass for a view that returned the parked one. */
    const pt = await svc.powerThrough(ctx, {});
    expect(pt.remaining).toBe(1);
    expect(pt.current!.id).toBe(b);
    expect(pt.nextCursor).toBeNull();
  });
});

/**
 * UN-PARKING RE-HOMES A READ ROW AT ITS OWN DATE (owner-ratified, 2026-08-24, §16 UI wave item 5).
 *
 * "Earlier" is ordered by `lastReadAt`; a row leaving a bottom pile used to keep whichever stamp
 * it happened to carry — the park-preceding glance (NOW-ish → the row surfaced at the TOP of
 * "Earlier" however old it was) or none at all (read in another client → filed under everything
 * ever stamped, effectively lost). The `none` transition now re-stamps a READ row's `lastReadAt`
 * to the message's own `date`, so it returns at its chronological slot. Scoped: only `none`,
 * only from a bottom pile, only a read row. The overlay half is pinned in
 * `packages/client-engine/test/unpark-rehoming.test.ts`.
 */
describe("un-parking re-homes lastReadAt to the message's own date", () => {
  const svc2 = new TriageService();
  const msgRow = async (db: Awaited<ReturnType<typeof makeCtx>>["db"], id: string) =>
    (await db.select().from(messages).where(eq(messages.id, id)))[0]!;

  it("leaving Answer Later: a READ row's lastReadAt becomes its date", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX", unread: false });
    // The pre-park glance stamped it just BEFORE the park (the clock is 07-28T12:00) and
    // AFTER the message's own date (07-28T09:00, the seed default) — the parked interlude's
    // stamp, which is exactly what the re-homing disowns.
    const glance = new Date("2026-07-28T10:00:00Z");
    await db.update(messages).set({ lastReadAt: glance }).where(eq(messages.id, id));

    await svc2.setState(ctx, id, { state: "reply_later" });
    // Entering the pile keeps the stamp — only leaving re-homes.
    expect((await msgRow(db, id)).lastReadAt?.toISOString()).toBe(glance.toISOString());

    await svc2.setState(ctx, id, { state: "none" });
    const row = await msgRow(db, id);
    expect(row.lastReadAt?.toISOString()).toBe(row.date?.toISOString());
    expect(row.lastReadAt?.toISOString()).not.toBe(glance.toISOString());
  });

  it("an unstamped read row (read in another client) gains its date stamp — not lost below the stamped", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX", unread: false });
    await svc2.setState(ctx, id, { state: "set_aside" });
    await svc2.setState(ctx, id, { state: "none" });
    const row = await msgRow(db, id);
    expect(row.lastReadAt?.toISOString()).toBe(row.date?.toISOString());
  });

  it("an UNREAD row un-parks with NO reading stamp invented", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX", unread: true });
    await svc2.setState(ctx, id, { state: "reply_later" });
    await svc2.setState(ctx, id, { state: "none" });
    expect((await msgRow(db, id)).lastReadAt).toBeNull();
  });

  it("a DATELESS row keeps whatever stamp it has — never nulled into the unstamped basement", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX", unread: false });
    const glance = new Date("2026-07-28T09:00:00Z");
    await db.update(messages).set({ lastReadAt: glance, date: null }).where(eq(messages.id, id));
    await svc2.setState(ctx, id, { state: "reply_later" });
    await svc2.setState(ctx, id, { state: "none" });
    expect((await msgRow(db, id)).lastReadAt?.toISOString()).toBe(glance.toISOString());
  });

  it("a stamp NEWER than the pile entry survives — the raced deliberate read wins either order", async () => {
    // `resurface_done` dispatches `triage_set: none` and a deliberate `mark_seen` without
    // awaiting; if the read's NOW stamp commits first, the re-homing must not rewind it to
    // the message's date. The predicate compares against the pile entry's own setAt.
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX", unread: false });
    await svc2.setState(ctx, id, { state: "bubbled_up", bubbleUpAt: "2026-08-01T09:00:00.000Z" });
    // The deliberate read lands first (a fresh act, AFTER the pile entry's setAt)…
    const doneNow = new Date("2026-07-28T12:30:00Z");
    await db.update(messages).set({ lastReadAt: doneNow }).where(eq(messages.id, id));
    // …then the un-awaited clear commits second: the NOW stamp survives.
    await svc2.setState(ctx, id, { state: "none" });
    expect((await msgRow(db, id)).lastReadAt?.toISOString()).toBe(doneNow.toISOString());
  });

  it("a SECOND cycle refreshes the pile entry's setAt — a stamp from between cycles still re-homes", async () => {
    // Cycle one at 12:00 (park+clear), a deliberate read at 13:00, cycle two's park at 14:00:
    // the predicate compares the 13:00 stamp against the CURRENT transition's instant, so the
    // 14:05 clear re-homes. With the conflict arm keeping cycle one's setAt (the review's
    // finding), 13:00 > 12:00 read as "newer than the pile entry" and the re-homing skipped.
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX", unread: false });
    await svc2.setState(ctx, id, { state: "reply_later" });
    await svc2.setState(ctx, id, { state: "none" });
    const glance = new Date("2026-07-28T13:00:00Z");
    await db.update(messages).set({ lastReadAt: glance }).where(eq(messages.id, id));
    const later: typeof ctx = { ...ctx, now: () => new Date("2026-07-28T14:00:00Z") };
    await svc2.setState(later, id, { state: "reply_later" });
    await svc2.setState(later, id, { state: "none" });
    const row = await msgRow(db, id);
    expect(row.lastReadAt?.toISOString()).toBe(row.date?.toISOString());
  });

  it("a stray `none` over a row that was in NO pile moves nothing", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", desired: "INBOX", unread: false });
    const stamp = new Date("2026-08-22T10:00:00Z");
    await db.update(messages).set({ lastReadAt: stamp }).where(eq(messages.id, id));
    await svc2.setState(ctx, id, { state: "none" });
    expect((await msgRow(db, id)).lastReadAt?.toISOString()).toBe(stamp.toISOString());
  });
});
