import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, messages, messageStates, flagState, changeLog, type Tx } from "@trafficflow/db";
import { bubbleUpPass } from "../src/bubble-up-cron.js";

async function seed(db: any, accountId: string, opts: { unread?: boolean; lastReadAt?: Date | null } = {}) {
  // Unique per call: `mailboxes_active_address_uq` is on lower(address), and the account-scoping
  // test below seeds two accounts into ONE database.
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `g-${randomUUID()}@tf.example` }).returning();
  const dedup = `mid:${randomUUID()}`;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "later", fromAddress: "a@ex.example", nativeLocator: { folder: "INBOX", ref: "1:1" },
    ...(opts.unread !== undefined ? { unread: opts.unread } : {}),
    ...(opts.lastReadAt !== undefined ? { lastReadAt: opts.lastReadAt } : {}),
  }).returning();
  return m.id;
}

/**
 * THE MAILBOXES THIS HOST ORGANIZES — the scope the pass takes now that it is per mailbox and not
 * per account. Every case in this file is one host holding everything it seeded, which is what
 * both production callers pass when they organize the whole account; the mixed install, where one
 * mailbox is organized and another handed over, is `bubble-up-mailbox-scope.pg.test.ts`.
 */
async function organizes(db: any, accountId: string): Promise<string[]> {
  const rows = await db.select({ id: mailboxes.id }).from(mailboxes)
    .where(eq(mailboxes.accountId, accountId));
  return rows.map((r: { id: string }) => r.id);
}

describe("bubble-up cron pass (F-3)", () => {
  it("flips a DUE bubbled_up state to RESURFACED and emits a message_state update change", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const msgId = await seed(db, accountId);

    const past = new Date("2026-07-27T00:00:00Z");
    const [st] = await db.insert(messageStates).values({
      accountId, messageId: msgId, state: "bubbled_up", bubbleUpAt: past,
    }).returning();

    const now = new Date("2026-07-28T12:00:00Z");
    const res = await bubbleUpPass(db as unknown as Tx, now, { mailboxIds: await organizes(db, accountId) });
    expect(res.flipped).toBe(1);

    // the due row becomes `resurfaced` — NOT `none` — so the Ohbox can pin it at the top; the
    // schedule is spent, so `bubbleUpAt` is cleared. A revert to `state: "none"` fails here.
    const [row] = await db.select().from(messageStates).where(eq(messageStates.id, st.id));
    expect(row.state).toBe("resurfaced");
    expect(row.bubbleUpAt).toBeNull();
    // `setAt` is "when the CURRENT state was set", refreshed by every transition (the one
    // deliberate preserver is `spendResurface`): a row scheduled at t1 and fired at t2 syncs
    // setAt = t2, the same instant a direct `resurface_now` would stamp — DTO timestamps must
    // not differ by transition path.
    expect(row.setAt?.toISOString()).toBe(now.toISOString());

    // A message_state UPDATE change was emitted through the change_log seam.
    const changes = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "message_state")))
      .orderBy(asc(changeLog.seq));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ op: "update", entityId: st.id });
    expect(changes[0].seq).toBe(1n);   // gap-free per-account seq allocated in the pass tx

    /* ── …AND THE MESSAGE BESIDE IT, WHICH IS THE HALF THAT REACHES A CLIENT ────────────────
     *
     * `MessageDTO.triage` is a projection of the row above, and the Ohbox pins on
     * `message.triage.state` (`selectors.ts#isResurfaced`) while `apply.ts` joins nothing. So the
     * `message_state` change alone moved the row in the database and for no reader — a whole
     * feature invisible to every test that looked only at the state row, which is what this
     * assertion did before. The pair is ordered `message_state` then `message`, so the higher seq
     * is the projection: a client applying a page in ascending seq lands the state first. */
    const all = await db.select().from(changeLog)
      .where(eq(changeLog.accountId, accountId)).orderBy(asc(changeLog.seq));
    expect(all.map((c) => [c.entityType, c.op])).toEqual([
      ["message_state", "update"], ["message", "update"],
    ]);
    expect(all[1]).toMatchObject({ entityId: msgId });
    expect(all[1]!.seq).toBe(2n);
  });

  it("leaves a NOT-yet-due bubbled_up state untouched and emits nothing", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const msgId = await seed(db, accountId);

    const future = new Date("2026-08-05T00:00:00Z");
    await db.insert(messageStates).values({ accountId, messageId: msgId, state: "bubbled_up", bubbleUpAt: future });

    const now = new Date("2026-07-28T12:00:00Z");
    const res = await bubbleUpPass(db as unknown as Tx, now, { mailboxIds: await organizes(db, accountId) });
    expect(res.flipped).toBe(0);

    const [row] = await db.select().from(messageStates).where(eq(messageStates.messageId, msgId));
    expect(row.state).toBe("bubbled_up");
    const changes = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    expect(changes).toHaveLength(0);
  });

  it("a second pass is a no-op (idempotent — already flipped rows are not re-emitted)", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const msgId = await seed(db, accountId);
    await db.insert(messageStates).values({
      accountId, messageId: msgId, state: "bubbled_up", bubbleUpAt: new Date("2026-07-27T00:00:00Z"),
    });
    const now = new Date("2026-07-28T12:00:00Z");
    expect((await bubbleUpPass(db as unknown as Tx, now, { mailboxIds: await organizes(db, accountId) })).flipped).toBe(1);
    expect((await bubbleUpPass(db as unknown as Tx, now, { mailboxIds: await organizes(db, accountId) })).flipped).toBe(0);
    // ONE flip's worth of changes and no more: the pair the first pass emitted, and nothing from
    // the second. Counting the pair rather than a single row is the point — a re-emitted
    // projection would announce a resurface the user already dismissed.
    const changes = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.entityType).sort()).toEqual(["message", "message_state"]);
  });
});

describe("the due event does NOT touch read state (owner ruling 2026-08-26)", () => {
  const past = new Date("2026-07-27T00:00:00Z");
  const now = new Date("2026-07-28T12:00:00Z");

  /**
   * THE OWNER'S SEQUENCE, worker half: a READ message is snoozed and comes due. It used to come
   * back forced-unread with its reading disowned and a `\\Seen` removal queued — and a companion
   * rescue pass re-applied that mark on every cycle, which is one of the two shapes of the
   * reported "turns back to unread". Now the flip moves the row and NOTHING else: genuine read
   * state kept, reading stamp kept, no flag intent, and no third change row.
   */
  it("a READ snoozed message comes back READ, its reading kept, with no \\Seen round trip", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const readAt = new Date("2026-07-20T09:00:00Z");
    const msgId = await seed(db, accountId, { unread: false, lastReadAt: readAt });
    await db.insert(messageStates).values({ accountId, messageId: msgId, state: "bubbled_up", bubbleUpAt: past });

    const res = await bubbleUpPass(db as unknown as Tx, now, { mailboxIds: await organizes(db, accountId) });
    expect(res).toMatchObject({ flipped: 1 });

    const [m] = await db.select().from(messages).where(eq(messages.id, msgId));
    expect(m.unread, "placement in Resurface is the signal — no artificial unread").toBe(false);
    expect(m.lastReadAt?.toISOString(), "the genuine reading stands").toBe(readAt.toISOString());

    // No IMAP intent: the mailbox's \Seen is genuine state and the flip leaves it alone.
    expect(await db.select().from(flagState).where(eq(flagState.messageId, msgId))).toHaveLength(0);

    // ONE event's worth of changes: the state row and its message projection. No third row.
    const changes = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId)).orderBy(asc(changeLog.seq));
    expect(changes.map((c) => c.entityType)).toEqual(["message_state", "message"]);
  });

  it("an UNREAD snoozed message comes back unread — genuine state in the other direction", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const msgId = await seed(db, accountId, { unread: true });
    await db.insert(messageStates).values({ accountId, messageId: msgId, state: "bubbled_up", bubbleUpAt: past });
    expect((await bubbleUpPass(db as unknown as Tx, now, { mailboxIds: await organizes(db, accountId) })).flipped).toBe(1);
    const [m] = await db.select().from(messages).where(eq(messages.id, msgId));
    expect(m.unread).toBe(true);
  });

  /**
   * THE FLIP-BACK, MADE IMPOSSIBLE BY ABSENCE: a resurfaced row that IS read stays read across
   * passes, whatever its reading stamp says. The old rescue pass re-unread exactly these rows
   * ("read with no stamp" and "read before the pin") on every cycle; it is deleted, not merely
   * narrowed, so both shapes are asserted.
   */
  it("a READ resurfaced row STAYS read on every subsequent pass — no rescue, no flip-back", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const pinnedAt = new Date("2026-07-27T06:00:00Z");
    // Shape 1: read, no reading stamp at all.
    const bare = await seed(db, accountId, { unread: false, lastReadAt: null });
    // Shape 2: read long BEFORE the pin.
    const dated = await seed(db, accountId, { unread: false, lastReadAt: new Date("2026-07-20T10:00:00Z") });
    for (const messageId of [bare, dated]) {
      await db.insert(messageStates).values({
        accountId, messageId, state: "resurfaced", bubbleUpAt: null, updatedAt: pinnedAt,
      });
    }

    const res = await bubbleUpPass(db as unknown as Tx, now, { mailboxIds: await organizes(db, accountId) });
    expect(res.flipped).toBe(0);
    for (const messageId of [bare, dated]) {
      const [m] = await db.select().from(messages).where(eq(messages.id, messageId));
      expect(m.unread, "the pass turned a read resurfaced row back to unread").toBe(false);
    }
    // …and emitted nothing: nothing moved, so no client hears about anything.
    expect(await db.select().from(changeLog).where(eq(changeLog.accountId, accountId))).toHaveLength(0);
  });

  it("a FUTURE schedule stays snoozed and untouched — read state included", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const msgId = await seed(db, accountId, { unread: false });
    await db.insert(messageStates).values({
      accountId, messageId: msgId, state: "bubbled_up", bubbleUpAt: new Date("2026-08-05T00:00:00Z"),
    });
    const res = await bubbleUpPass(db as unknown as Tx, now, { mailboxIds: await organizes(db, accountId) });
    expect(res.flipped).toBe(0);
    const [m] = await db.select().from(messages).where(eq(messages.id, msgId));
    expect(m.unread).toBe(false);
    expect(await db.select().from(flagState).where(eq(flagState.messageId, msgId))).toHaveLength(0);
  });
});
