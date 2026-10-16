import { describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { flagState, messages } from "@trafficflow/db";
import { MessageService, type ServiceContext } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * ONE READING DECISION STAMPS ONE TIME.
 *
 * `markSeen` minted `lastReadAt` once for the batch and `updatedAt` (and the `\Seen` intent) per
 * row, so one gesture stamped its rows however far apart the statements landed. It is invisible
 * under a frozen clock and rare under a wall clock — one post-push run caught it once, as a recorded
 * wire response whose `updatedAt` was a millisecond past its own `lastReadAt`. The clock here
 * ADVANCES one millisecond per call, so every mint the code makes is a distinct value and the
 * defect is deterministic rather than a flake.
 */

/** Far from any wall clock, so a stamp on this grid cannot be `defaultNow()`'s. */
const t0 = Date.UTC(2031, 0, 1, 0, 0, 0);

function tickingCtx(base: ServiceContext): ServiceContext {
  let n = 0;
  return { ...base, now: () => new Date(t0 + (n += 1)) };
}

const ms = (d: Date | null): number | null => (d === null ? null : d.getTime());

describe("a read-state decision stamps one instant", () => {
  it("the clock under test advances — without this every assertion below passes for nothing", async () => {
    const { ctx } = await makeCtx();
    const t = tickingCtx(ctx);
    expect(t.now().getTime()).not.toBe(t.now().getTime());
  });

  it("a batch marked read: every row's lastReadAt, updatedAt and \\Seen intent are ONE instant", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const t = tickingCtx(ctx);
    const a = await seedMessage(db, accountId, mailboxId, { unread: true });
    const b = await seedMessage(db, accountId, mailboxId, { unread: true });

    await new MessageService().markSeen(t, { ids: [a, b], unread: false });

    const rows = await db.select().from(messages).where(inArray(messages.id, [a, b]));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(ms(r.lastReadAt), `${r.id}: lastReadAt and updatedAt are the same event`)
        .toBe(ms(r.updatedAt));
      // On OUR grid, so the value is `ctx.now()`'s and not a column default left in place.
      expect(r.updatedAt.getTime()).toBeGreaterThan(t0);
      expect(r.updatedAt.getTime()).toBeLessThan(t0 + 1000);
    }
    expect(ms(rows[0]!.updatedAt), "two rows of one gesture stamp one time").toBe(ms(rows[1]!.updatedAt));
  });

  it("marking read AGAIN: the intent row the second press updates takes that press's instant", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const t = tickingCtx(ctx);
    const a = await seedMessage(db, accountId, mailboxId, { unread: true });
    const svc = new MessageService();

    // The first press INSERTS `flag_state` (its `updatedAt` is the column default there); the
    // second takes the conflict branch, which is the one `upsertDesiredSeen` stamps.
    await svc.markSeen(t, { ids: [a], unread: false });
    await svc.markSeen(t, { ids: [a], unread: false });

    const [row] = await db.select().from(messages).where(inArray(messages.id, [a]));
    const [fs] = await db.select().from(flagState).where(inArray(flagState.messageId, [a]));
    expect(ms(fs!.updatedAt), "the intent and the row are stamped by one read of the clock")
      .toBe(ms(row!.updatedAt));
  });

  it("marking UNREAD clears lastReadAt and still stamps one updatedAt across the batch", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const t = tickingCtx(ctx);
    const a = await seedMessage(db, accountId, mailboxId, { unread: false });
    const b = await seedMessage(db, accountId, mailboxId, { unread: false });

    await new MessageService().markSeen(t, { ids: [a, b], unread: true });

    const rows = await db.select().from(messages).where(inArray(messages.id, [a, b]));
    for (const r of rows) {
      expect(r.lastReadAt, "marking unread has no reading to be ordered by").toBeNull();
      expect(r.updatedAt.getTime()).toBeGreaterThan(t0);
    }
    expect(ms(rows[0]!.updatedAt)).toBe(ms(rows[1]!.updatedAt));
  });

  it("the single-message PATCH stamps its reading and its row from one read of the clock", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const t = tickingCtx(ctx);
    const a = await seedMessage(db, accountId, mailboxId, { unread: true });

    await new MessageService().patch(t, a, { unread: false });

    const [row] = await db.select().from(messages).where(inArray(messages.id, [a]));
    expect(ms(row!.lastReadAt)).toBe(ms(row!.updatedAt));
    expect(row!.updatedAt.getTime()).toBeGreaterThan(t0);
  });
});
