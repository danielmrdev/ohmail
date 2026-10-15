/**
 * "NOT DELETED" IS SAID ONLY ONCE THE UNDO IS ON DISK (PHONE-UNDONE-SAID-BEFORE-THE-UNDO-IS-SAVED).
 * Undo queued the journal row's removal and said the sentence at once; a kill before the removal
 * landed left the row, and the next launch moved the message to Trash under a screen that had said
 * it was not deleted. The harness is `delete-window-survives-a-kill`'s (a fresh module graph over
 * the same device sqlite per launch); the journal here can HOLD its writes, which is the kill's
 * window made wide enough to stand in: a held write that is never released never reached the disk.
 */
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROUTING_INTENT_TTL_MS,
  ROUTING_JOURNAL_TYPE,
  SqlMirrorStore,
  type SqlExecutor,
  type SqlRow,
  type SqlValue,
} from "@ohmail/client-engine";
import { sayRefusal } from "../src/refusal";
import type { DeleteReplay } from "../src/state/held-delete";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function nodeSqlExecutor(db: DatabaseSync): SqlExecutor {
  return {
    async all(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<SqlRow[]> {
      return db.prepare(sql).all(...params) as SqlRow[];
    },
    async batch(statements): Promise<void> {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...params);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

/** The device's disk: one sqlite database per name, outliving every process that opens it. */
function device() {
  const dbs = new Map<string, DatabaseSync>();
  return {
    open: (name: string): SqlExecutor => {
      let db = dbs.get(name);
      if (!db) { db = new sqlite.DatabaseSync(":memory:"); dbs.set(name, db); }
      return nodeSqlExecutor(db);
    },
  };
}

const OWNER = "http://sidecar::acct-delete-kill";
const AT = 1_000_000;
const WINDOW_MS = 8000;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** One launch: a fresh binding over the device, whose dispatch answers `answer` for each id. */
async function launch(
  disk: ReturnType<typeof device>, now: number,
  answer: (id: string) => boolean | "nothing" = () => true,
) {
  vi.resetModules();
  const binding = await import("../src/state/held-delete");
  const store = new SqlMirrorStore({ owner: OWNER, open: disk.open });
  await store.load();
  const sent: string[] = [];
  const replays: DeleteReplay[] = [];
  binding.openDeleteSession({
    journal: store,
    now: () => now,
    dispatch: async (id) => { sent.push(id); return answer(id); },
    onReplayed: (r) => replays.push(r),
  });
  return { binding, store, sent, replays };
}

async function journalOnDisk(disk: ReturnType<typeof device>): Promise<unknown[]> {
  const store = new SqlMirrorStore({ owner: OWNER, open: disk.open });
  await store.load();
  const rows = store.entries<{ value: string }>(ROUTING_JOURNAL_TYPE)
    .filter((e) => e.id === "ohmail.delete.intents.local")
    .flatMap((e) => JSON.parse(e.entity.value) as unknown[]);
  store.close();
  return rows;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

/** The kill: the window's timer never fires and nothing is flushed or closed. */
const kill = (): void => { vi.clearAllTimers(); };

async function press(binding: typeof import("../src/state/held-delete"), id: string, sent: string[]) {
  const toasts: { say: string; undo?: () => void }[] = [];
  await binding.runDeleteCeremony({
    id, windowMs: WINDOW_MS,
    toast: (say, opts) => toasts.push({ say: String(say), ...(opts?.undo ? { undo: opts.undo } : {}) }),
    deleted: "Moved to Trash.", undone: "Not deleted.", undoLost: "Could not undo.",
    dispatchQuiet: () => { sent.push(`quiet:${id}`); },
  });
  return toasts;
}


/** The device's store with a door on its writes: `hold()` parks every later write until `release()`. */
function holding(store: SqlMirrorStore) {
  let held: Array<() => void> | null = null;
  let refuse = false;
  const journal = {
    get: <T,>(type: string, id: string) => store.get<T>(type, id),
    commitLocal: (
      puts: ReadonlyArray<{ type: string; id: string; entity: unknown }>,
      deletes: ReadonlyArray<{ type: string; id: string }>,
    ): Promise<void> => {
      if (refuse) return Promise.reject(new Error("disk full"));
      if (held === null) return store.commitLocal(puts, deletes);
      const parked = held;
      return new Promise<void>((resolve, reject) => {
        parked.push(() => { store.commitLocal(puts, deletes).then(resolve, reject); });
      });
    },
  };
  return {
    journal,
    hold: () => { held = []; },
    refuse: () => { refuse = true; },
    release: () => { const go = held ?? []; held = null; for (const f of go) f(); },
  };
}

async function launchHolding(disk: ReturnType<typeof device>, now: number) {
  vi.resetModules();
  const binding = await import("../src/state/held-delete");
  const store = new SqlMirrorStore({ owner: OWNER, open: disk.open });
  await store.load();
  const door = holding(store);
  const sent: string[] = [];
  binding.openDeleteSession({ journal: door.journal, now: () => now, dispatch: async (id) => { sent.push(id); return true; } });
  return { binding, door, sent };
}

const NOT_DELETED = "Not deleted.";

describe("Undo says Not deleted only once the undo is saved", () => {
  it("a journal that never confirms keeps Not deleted off the screen, and the row out of the lists", async () => {
    const disk = device();
    const first = await launchHolding(disk, AT);
    const toasts = await press(first.binding, "m1", first.sent);
    expect(toasts[0]?.undo, "control: the pill offered Undo").toBeDefined();
    first.door.hold();
    toasts[0]!.undo!();
    await settle();
    expect(toasts.map((t) => t.say), "Not deleted was said over a removal still in flight").not.toContain(NOT_DELETED);
    expect([...first.binding.heldDeleteIds()], "the row came back before its undo was saved").toEqual(["m1"]);
    first.binding.flushHeldDeletes(); // backgrounding while the undo is in flight is not a delete
    expect(first.sent).toEqual([]);
    first.door.release();
    await settle();
    expect(toasts.map((t) => t.say), "control: the saved undo is said").toContain(NOT_DELETED);
    expect(first.binding.heldDeleteIds().size).toBe(0);
    expect(first.sent, "an undone delete was sent").toEqual([]);
  });

  it("killed the moment Not deleted is on screen, the relaunch leaves the message in place", async () => {
    const disk = device();
    const first = await launchHolding(disk, AT);
    const toasts = await press(first.binding, "m1", first.sent);
    first.door.hold();
    toasts[0]!.undo!();
    await settle();
    // The kill lands at the sentence: while it is not on screen the write may still land.
    if (!toasts.some((t) => t.say === NOT_DELETED)) {
      first.door.release();
      await settle();
    }
    expect(toasts.map((t) => t.say), "control: Not deleted was said").toContain(NOT_DELETED);
    kill(); // anything still held never reaches the disk

    const next = await launch(disk, AT + 3_000);
    await settle();
    expect(next.sent, "the screen said Not deleted and the next launch moved it to Trash").toEqual([]);
    expect(next.replays).toEqual([]);
  });

  it("killed before the undo is saved, nothing said it was undone and the launch says what it did", async () => {
    const disk = device();
    const first = await launchHolding(disk, AT);
    const toasts = await press(first.binding, "m1", first.sent);
    first.door.hold();
    toasts[0]!.undo!();
    await settle();
    kill();
    const next = await launch(disk, AT + 3_000);
    await settle();
    expect(next.sent).toEqual(["m1"]);
    expect(toasts.map((t) => t.say)).not.toContain(NOT_DELETED);
    expect(next.replays.flatMap(next.binding.deleteReplaySay).map(sayRefusal))
      .toEqual(["Moved 1 message to Trash that was waiting when ohmail closed."]);
  });

  it("a session reopened over the same mirror while an undo is saving does not replay that press", async () => {
    /* LOW-1: Delete, Undo (the removal queued), the world reopens the delete
       session over the SAME store before the removal commits. The replay read the row, sent the
       delete, and the phone then said "Not deleted." over a message in Trash. */
    const disk = device();
    const first = await launchHolding(disk, AT);
    const toasts = await press(first.binding, "m1", first.sent);
    first.door.hold();
    toasts[0]!.undo!();
    await settle();
    const replayed: string[] = [];
    first.binding.openDeleteSession({
      journal: first.door.journal, now: () => AT + 1_000,
      dispatch: async (id) => { replayed.push(id); return true; },
    });
    await settle();
    first.door.release();
    await settle();
    expect(replayed, "the reopened session replayed a press whose undo was saving").toEqual([]);
    expect(toasts.map((t) => t.say), "control: the saved undo is said").toContain(NOT_DELETED);
    expect(first.sent).toEqual([]);
    // The kill-after-sentence invariant still holds on the reopened session's disk.
    kill();
    const next = await launch(disk, AT + 3_000);
    await settle();
    expect(next.sent, "the next launch deleted what the screen said was not deleted").toEqual([]);
    expect(next.replays).toEqual([]);
  });

  it("a refused undo write says so, and the delete it could not take back goes ahead", async () => {
    const disk = device();
    const first = await launchHolding(disk, AT);
    const toasts: { say: string; undo?: () => void }[] = [];
    await first.binding.runDeleteCeremony({
      id: "m1", windowMs: WINDOW_MS,
      toast: (say, opts) => toasts.push({ say: String(say), ...(opts?.undo ? { undo: opts.undo } : {}) }),
      deleted: "Moved to Trash.", undone: NOT_DELETED, undoLost: "Could not undo.",
      dispatchQuiet: () => { first.sent.push("quiet:m1"); },
    });
    first.door.refuse();
    toasts[0]!.undo!();
    await settle();
    expect(toasts.map((t) => t.say)).not.toContain(NOT_DELETED);
    expect(toasts.map((t) => t.say), "a refused undo write was silent").toContain("Could not undo.");
    expect(first.sent, "the delete the undo could not take back did not go ahead").toEqual(["quiet:m1"]);
  });
});
