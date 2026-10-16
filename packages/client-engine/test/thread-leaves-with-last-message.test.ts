import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, type MirrorRecord, type SyncChange } from "@ohmail/client-engine";

/**
 * A CONVERSATION WHOSE LAST LETTER LEFT LEAVES THE MIRROR WITH IT.
 *
 * The server keeps a thread row when its only message is expunged, so every mirror kept the
 * thread's subject and participants with nothing left to render. The store now tombstones a
 * thread in the same write as the delete that leaves every message it names tombstoned. A thread
 * naming a live letter, or one this window never held, stays: absence is not deletion.
 */

class RecordingStore extends MemoryMirrorStore {
  readonly writes: string[][] = [];
  protected override async persist(dirty: MirrorRecord[] = []): Promise<void> {
    this.writes.push(dirty.map((r) => `${r.type}:${r.id}${r.entity === null ? ":gone" : ""}`));
  }
}

const iso = "2026-09-27T00:00:00.000Z";
const change = (type: string, id: string, op: SyncChange["op"], seq: number, entity?: unknown): SyncChange =>
  ({ type, op, id, seq, updatedAt: iso, ...(entity !== undefined ? { entity } : {}) }) as SyncChange;

const thread = (id: string, messageIds: string[], seq: number) => change("thread", id, "create", seq, {
  id, accountId: "acct", subject: `about ${id}`, messageIds,
  participants: [{ name: null, address: "someone@example.test" }], lastMessageAt: iso,
  unreadCount: 1, muted: false, folder: "INBOX", updatedAt: iso,
});
const message = (id: string, threadId: string, seq: number) => change("message", id, "create", seq, {
  id, accountId: "acct", mailboxId: "mb", threadId, subject: id, folder: "INBOX", unread: true, date: iso,
});

async function page(store: MemoryMirrorStore, changes: SyncChange[], cursor: string): Promise<void> {
  await store.applyResponse({
    changes: {
      creates: changes.filter((c) => c.op === "create"),
      updates: changes.filter((c) => c.op === "update"),
      moves: [],
      deletes: changes.filter((c) => c.op === "delete"),
    },
    cursor, hasMore: false, serverTime: iso,
  });
}

async function seeded(): Promise<RecordingStore> {
  const store = new RecordingStore();
  await store.load();
  await page(store, [
    thread("t-alone", ["m-alone"], 1), message("m-alone", "t-alone", 2),
    thread("t-two", ["m-a", "m-b"], 3), message("m-a", "t-two", 4), message("m-b", "t-two", 5),
    // A conversation whose second letter this window never held (evicted, or outside it).
    thread("t-part", ["m-held", "m-elsewhere"], 6), message("m-held", "t-part", 7),
  ], "7");
  store.writes.length = 0;
  return store;
}

describe("a thread with no live letter leaves the client store", () => {
  it("the only letter's delete takes its thread, in the same write", async () => {
    const store = await seeded();
    await page(store, [change("message", "m-alone", "delete", 10)], "10");

    expect(store.get("thread", "t-alone"), "the conversation of a deleted letter is still stored").toBeUndefined();
    expect(store.isTombstoned("thread", "t-alone")).toBe(true);
    expect(store.writes, "the thread left in a write of its own").toEqual([["message:m-alone:gone", "thread:t-alone:gone"]]);
  });

  it("two letters deleted in one page take their thread", async () => {
    const store = await seeded();
    await page(store, [change("message", "m-a", "delete", 10), change("message", "m-b", "delete", 11)], "11");
    expect(store.get("thread", "t-two")).toBeUndefined();
  });

  it("CONTROL — a thread with one remaining live letter stays", async () => {
    const store = await seeded();
    await page(store, [change("message", "m-a", "delete", 10)], "10");
    expect(store.get("thread", "t-two"), "a conversation with a live letter was removed").toBeDefined();
  });

  it("CONTROL — a letter this window never held is not a deleted one", async () => {
    const store = await seeded();
    await page(store, [change("message", "m-held", "delete", 10)], "10");
    expect(store.get("thread", "t-part"), "an unheld letter was read as a deletion").toBeDefined();
  });

  it("CONTROL — a replayed page takes nothing more, and an older thread change cannot bring it back", async () => {
    const store = await seeded();
    const del = [change("message", "m-alone", "delete", 10)];
    await page(store, del, "10");
    store.writes.length = 0;
    await page(store, del, "10");
    await page(store, [thread("t-alone", ["m-alone"], 1)], "10");
    expect(store.get("thread", "t-alone")).toBeUndefined();
    expect(store.writes.flat().some((k) => k.startsWith("thread:")), "a replay wrote the thread again").toBe(false);
  });

  it("a later thread change brings the conversation back", async () => {
    const store = await seeded();
    await page(store, [change("message", "m-alone", "delete", 10)], "10");
    await page(store, [thread("t-alone", ["m-alone", "m-new"], 12), message("m-new", "t-alone", 13)], "13");
    expect(store.get("thread", "t-alone")).toBeDefined();
  });

  it("the thread arriving after its letter's delete leaves too — the order does not decide", async () => {
    const store = new RecordingStore();
    await store.load();
    await page(store, [change("message", "m-late", "delete", 10)], "10");
    await page(store, [thread("t-late", ["m-late"], 3)], "10");
    expect(store.get("thread", "t-late"), "a shuffled stream kept the thread").toBeUndefined();
    // …and at the seq the in-order stream tombstones it: a thread change at 5 is refused, not
    // applied and removed again, so nothing about the thread is written.
    store.writes.length = 0;
    await page(store, [thread("t-late", ["m-late"], 5)], "10");
    expect(store.get("thread", "t-late")).toBeUndefined();
    expect(store.writes.flat(), "the stale thread change was applied").toEqual([]);
  });

  it("applyChanges takes the thread the same way", async () => {
    const store = await seeded();
    await store.applyChanges([change("message", "m-alone", "delete", 10)]);
    expect(store.get("thread", "t-alone")).toBeUndefined();
    expect(store.writes).toEqual([["message:m-alone:gone", "thread:t-alone:gone"]]);
  });
});
