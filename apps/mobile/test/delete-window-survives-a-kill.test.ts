/**
 * A DELETE PRESSED INSIDE ITS UNDO WINDOW SURVIVES A KILL (FIX-026 row 91). The press was a timer
 * closure, so a force-stop inside the eight seconds lost it while the pill had said "Moved to
 * Trash.". Each launch below is a fresh module graph over the same device sqlite (a new process),
 * the kill is every timer cleared with nothing closed, and the reading is the dispatch seam, the
 * journal row on disk and the sentence the next launch says. Mutations: the `landed` await (Undo
 * offered off-disk), the launch commit, the synchronous row removal at Undo.
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

describe("a delete killed inside its window", () => {
  it("is on disk before its Undo is offered, and the next launch deletes it and says so", async () => {
    const disk = device();
    const first = await launch(disk, AT);
    const toasts = await press(first.binding, "m1", first.sent);
    expect(toasts[0]?.undo, "control: the pill offered Undo").toBeDefined();
    expect(first.sent, "a delete went out inside the undo window").toEqual([]);
    expect(await journalOnDisk(disk), "the Undo was offered over a press only memory held")
      .toEqual([{ id: "m1", messageIds: ["m1"], at: AT, kind: "delete" }]);
    kill();

    const next = await launch(disk, AT + 3_000);
    expect(next.sent, "the delete the person made was not made at the next launch").toEqual(["m1"]);
    await settle();
    expect(next.replays).toEqual([{ moved: 1, expired: 0, refused: 0 }]);
    expect(next.replays.flatMap(next.binding.deleteReplaySay).map(sayRefusal))
      .toEqual(["Moved 1 message to Trash that was waiting when ohmail closed."]);
    expect(await journalOnDisk(disk), "the committed press stayed to be committed again").toEqual([]);

    kill();
    const third = await launch(disk, AT + 6_000);
    expect(third.sent, "a second launch deleted it a second time").toEqual([]);
    await settle();
    expect(third.replays).toEqual([]);
  });

  it("an Undo removes the row at once, so nothing is deleted at the next launch", async () => {
    const disk = device();
    const first = await launch(disk, AT);
    const toasts = await press(first.binding, "m1", first.sent);
    toasts[0]!.undo!();
    await settle();
    expect(await journalOnDisk(disk)).toEqual([]);
    kill();
    const next = await launch(disk, AT + 3_000);
    await settle();
    expect(next.sent).toEqual([]);
    expect(next.replays).toEqual([]);
  });

  it("a message no longer in the mirror is skipped and said; one past the horizon is dropped and said", async () => {
    const disk = device();
    const first = await launch(disk, AT);
    await press(first.binding, "gone", first.sent);
    kill();
    const skipped = await launch(disk, AT + 1_000, () => "nothing");
    await settle();
    expect(skipped.sent).toEqual(["gone"]);
    expect(skipped.replays, "a skipped id was counted as a delete, or dropped unsaid")
      .toEqual([{ moved: 0, expired: 0, refused: 0, gone: 1 }]);
    /* PHONE-DELETE-REPLAY-SKIPS-A-STORE-ROW: a History or Search row's press finds nothing to
       commit at the launch; the press is lost, and it is SAID. */
    expect(skipped.replays.flatMap(skipped.binding.deleteReplaySay).map(sayRefusal)).toEqual([
      "1 message was not moved to Trash — this phone could not find it when the app started again. Delete it again if you still want it there.",
    ]);

    kill();
    const again = await launch(disk, AT);
    await press(again.binding, "old", again.sent);
    kill();
    const late = await launch(disk, AT + ROUTING_INTENT_TTL_MS + 1);
    await settle();
    expect(late.sent, "a day-old delete was made").toEqual([]);
    expect(late.replays).toEqual([{ moved: 0, expired: 1, refused: 0 }]);
    expect(late.replays.flatMap(late.binding.deleteReplaySay).map(sayRefusal)[0]).toContain("not moved to Trash");
    expect(await journalOnDisk(disk)).toEqual([]);
  });

  it("a record that did not land commits now and offers no Undo", async () => {
    vi.resetModules();
    const binding = await import("../src/state/held-delete");
    const sent: string[] = [];
    binding.openDeleteSession({
      journal: { get: () => undefined, commitLocal: async () => { throw new Error("disk full"); } },
      dispatch: async () => true,
    });
    const toasts = await press(binding, "m1", sent);
    expect(toasts).toEqual([{ say: "Moved to Trash." }]);
    expect(sent, "the delete was not made at once").toEqual(["quiet:m1"]);
    expect(binding.heldDeleteIds().size).toBe(0);
  });
});
