import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, type SyncChange } from "@ohmail/client-engine";

/**
 * THE STORE'S PER-TYPE BUCKETS — `list`/`entries` no longer walk every record for every query.
 *
 * The cache is keyed on the store's own version stamp, so its one dangerous property is
 * staleness: a write that failed to bump the version would serve yesterday's bucket. These
 * tests pin visibility across every mutation family and the fresh-array contract (callers
 * sort `list()`'s result in place — a shared array would corrupt the cache).
 */

let seq = 0;
const change = (type: string, id: string, entity: unknown | null): SyncChange =>
  ({ type, op: entity === null ? "delete" : "create", id, seq: ++seq, updatedAt: "2026-08-01T00:00:00.000Z", ...(entity === null ? {} : { entity }) }) as SyncChange;

describe("per-type buckets", () => {
  it("a new row is visible immediately after the write that adds it", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([change("tag", "t1", { id: "t1" }), change("message", "m1", { id: "m1" })]);
    expect(store.list("tag")).toHaveLength(1); // prime the bucket
    await store.applyChanges([change("tag", "t2", { id: "t2" })]);
    expect(store.list<{ id: string }>("tag").map((t) => t.id).sort()).toEqual(["t1", "t2"]);
  });

  it("a delete disappears from the bucket on the next read", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([change("tag", "t1", { id: "t1" }), change("tag", "t2", { id: "t2" })]);
    expect(store.list("tag")).toHaveLength(2);
    await store.applyChanges([change("tag", "t1", null)]);
    expect(store.list<{ id: string }>("tag").map((t) => t.id)).toEqual(["t2"]);
  });

  it("a client-local putLocal is visible immediately", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    expect(store.list("message_body")).toHaveLength(0); // prime the (empty) bucket
    await store.putLocal("message_body", "m1", { text: "hello" });
    expect(store.list("message_body")).toHaveLength(1);
  });

  it("list() hands out a FRESH array — the caller's in-place sort cannot corrupt later reads", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([change("tag", "b", { id: "b" }), change("tag", "a", { id: "a" })]);
    const first = store.list<{ id: string }>("tag");
    first.sort((x, y) => x.id.localeCompare(y.id));
    first.pop();
    expect(store.list("tag")).toHaveLength(2);
  });

  /**
   * The `seq` is the record's last-applied one, and it is here rather than derived because the
   * windowed prune's one-page grace reads it: a row that arrived in the page being applied is not
   * yet evictable. An `entries()` that dropped it would leave that guard nothing to read.
   */
  it("entries carries the same rows with their ids and their applied seq", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const ch = change("view_thing", "v1", { n: 1 });
    await store.applyChanges([ch]);
    expect(store.entries("view_thing")).toEqual([{ id: "v1", entity: { n: 1 }, seq: ch.seq }]);
  });
});
