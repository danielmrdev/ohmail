import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, changeLog, mailboxes, messageInstances, messages, recordChanges, threads, type LedgerTx,
} from "@trafficflow/db";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { MemoryMirrorStore, threadSizeIndex } from "@ohmail/client-engine";
import { SyncService, ThreadService, type ServiceContext } from "@trafficflow/services";

/**
 * A CONVERSATION COUNTS THE LETTERS IT STILL HOLDS (THREAD-COUNT-INCLUDES-DELETED-LETTERS).
 *
 * The thread listed every message with its `thread_id`, tombstoned ones included, and the client
 * takes that list's length as the conversation's size. The reaper tombstones through its own door
 * here, then the service thread and a mirror that already holds the thread are read, on both
 * stores. Mutations: drop the live filter in `materializeThread(s)`, or the reaper's thread change.
 */

const NOW = new Date("2026-09-27T05:00:00.000Z");
const sync = new SyncService();
type Db = Awaited<ReturnType<typeof makeTestDb>>;
const ctxFor = (db: Db, accountId: string): ServiceContext =>
  ({ db, accountId, userId: null, now: () => NOW, requestId: "thread-live-letters" });

async function seed(db: Db) {
  const [a] = await db.insert(accounts).values({ name: "thread-live-letters" }).returning();
  const accountId = a!.id;
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `t-${accountId.slice(0, 8)}@example.test` }).returning();
  const mailboxId = mb!.id;
  const [pair] = await db.insert(threads).values({ accountId }).returning();
  const [single] = await db.insert(threads).values({ accountId }).returning();
  const plant = async (threadId: string, n: number, folder: string) => {
    const key = `r${n}-${accountId.slice(0, 8)}@example.test`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, threadId, messageIdHeader: key, bodyHash: key, dedupKey: `mid:<${key}>`,
      subject: "the plan", fromAddress: "anna@example.test", date: new Date(NOW.getTime() + n * 1000),
      nativeLocator: { folder, ref: `7:${n}` },
    }).returning();
    await db.insert(messageInstances).values({
      accountId, mailboxId, messageId: m!.id, folder, uidvalidity: 7n, uid: n, isPrimary: true,
    });
    return m!.id;
  };
  const kept = await plant(pair!.id, 1, "INBOX");
  const reply = await plant(pair!.id, 2, "Projects");
  const lone = await plant(single!.id, 3, "Projects");
  await db.transaction(async (tx) => {
    await recordChanges(tx as unknown as LedgerTx, [
      ...[pair!.id, single!.id].map((id) => ({ accountId, entityType: "thread" as const, entityId: id, op: "create" as const, meta: null })),
      ...[kept, reply, lone].map((id) => ({ accountId, entityType: "message" as const, entityId: id, op: "create" as const, meta: null })),
    ]);
  });
  return { accountId, mailboxId, pair: pair!.id, single: single!.id, kept, reply, lone };
}

async function drain(store: MemoryMirrorStore, ctx: ServiceContext, since?: string): Promise<string> {
  let cursor = since;
  for (;;) {
    const resp = await sync.getChanges(ctx, cursor === undefined ? {} : { since: cursor });
    await store.applyResponse(resp);
    cursor = resp.cursor;
    if (!resp.hasMore) return cursor;
  }
}

describe("a conversation counts the letters it still holds", () => {
  it("a letter reaped as gone leaves the thread's list, and a mirror that held the thread counts one", async () => {
    const db = await makeTestDb();
    const s = await seed(db);
    const ctx = ctxFor(db, s.accountId);
    const store = new MemoryMirrorStore();
    await store.load();
    const cursor = await drain(store, ctx);
    expect(threadSizeIndex(store).get(s.pair)?.count, "the precondition: the mirror counts two").toBe(2);

    const repo = makeDrizzleRepo(db as never);
    await repo.forgetInstanceAt(s.mailboxId, { folder: "Projects", ref: "7:2" });
    await repo.forgetInstanceAt(s.mailboxId, { folder: "Projects", ref: "7:3" });
    expect(await repo.transaction((r) => r.tombstoneInstanceless(s.accountId, s.mailboxId, 50))).toBe(2);

    expect((await new ThreadService().get(ctx, s.pair)).messageIds, "the thread still lists the deleted reply").toEqual([s.kept]);
    await drain(store, ctx, cursor);
    expect(store.get("message", s.reply)).toBeUndefined();
    expect(threadSizeIndex(store).get(s.pair)?.count, "the synced conversation still counts the deleted reply").toBe(1);
  });

  it("a thread emptied of letters is not served again; its letters reached the client as deleted", async () => {
    const db = await makeTestDb();
    const s = await seed(db);
    const repo = makeDrizzleRepo(db as never);
    await repo.forgetInstanceAt(s.mailboxId, { folder: "Projects", ref: "7:3" });
    await repo.transaction((r) => r.tombstoneInstanceless(s.accountId, s.mailboxId, 50));
    const rows = await db.select({ op: changeLog.op, type: changeLog.entityType }).from(changeLog)
      .where(and(eq(changeLog.accountId, s.accountId), eq(changeLog.entityId, s.single)));
    expect(rows, "an emptied thread was announced again").toEqual([{ op: "create", type: "thread" }]);
    expect((await new ThreadService().get(ctxFor(db, s.accountId), s.single)).messageIds).toEqual([]);
  });
});
