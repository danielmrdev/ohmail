import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbMirrorStore } from "../src/idb.js";
import { OhmailEngine } from "../src/engine.js";
import type { EngineAdapter, SyncChange } from "../src/types.js";

/**
 * ═══ THE DEVICE ALREADY HAS THE MAIL. THE SCREEN HAS TO BE TOLD. ═══════════════════════════
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────
 *
 * Reported 2026-08-04: opening ohmail.app signed in, on a slow connection, shows "no messages" for
 * several seconds.
 *
 * The mirror PERSISTS — `IndexedDbMirrorStore`, one database per account, named and stamped with
 * a server-verified account id — so a returning user's whole mailbox is already on the device.
 * `store.load()` reads it into memory and bumps the store's version. It notified NOBODY: the
 * listener set lives on the engine, and `notify()` was reachable only from `drain()` and the
 * mutation paths. So the rows appeared when the first `/sync` page landed, which on a slow link
 * is the second of two serial round trips — and until then the panes stated, as settled fact,
 * that there was nothing there.
 *
 * That it often looked fine anyway is the dangerous part and the reason this guard exists at the
 * engine rather than only in the app: `useSyncExternalStore` re-reads its snapshot on ANY render,
 * so an unrelated re-paint (the mailbox probe answering) usually published the mirror by
 * accident. The behaviour was correct by coincidence and one refactor from being wrong again.
 *
 * ── WHY THE ASSERTIONS ARE WHAT THEY ARE ────────────────────────────────────────────────
 *
 * `notify()` is private and the listener is the only observable. Counting calls is therefore the
 * property itself, not a proxy for it: a hydration nothing hears is exactly the bug.
 *
 * Each case drives a real `IDBFactory` and a REAL second engine over the same database, because
 * "the mirror persists across a reload" is the premise the whole fix rests on and a
 * `MemoryMirrorStore` would assume it rather than show it.
 */

const ISO = "2026-08-04T09:00:00.000Z";

const create = (id: string, seq: number): SyncChange =>
  ({
    type: "message",
    op: "create",
    id,
    seq,
    updatedAt: ISO,
    entity: { id, subject: `subject of ${id}`, folder: "INBOX", unread: true },
  }) as unknown as SyncChange;

/** An adapter whose `/sync` NEVER answers — the slow connection, held open. */
const heldAdapter = (): EngineAdapter =>
  ({
    sync: () => new Promise(() => {}),
    mutate: async () => ({ status: "applied" }),
    fetchBody: async () => null,
  }) as unknown as EngineAdapter;

/** Seed a persisted mirror for `owner` with `n` messages, then close it. */
async function seed(factory: IDBFactory, owner: string, n: number): Promise<void> {
  const store = new IndexedDbMirrorStore({ owner, factory });
  await store.load();
  await store.applyResponse({
    changes: {
      creates: Array.from({ length: n }, (_, i) => create(`m${i + 1}`, i + 1)),
      updates: [],
      moves: [],
      deletes: [],
    },
    cursor: `c${n}`,
    hasMore: false,
    serverTime: ISO,
  } as never);
  store.close();
}

describe("hydrating the mirror publishes it", () => {
  it("a returning tab paints the device's copy with ZERO answers from the network", async () => {
    const factory = new IDBFactory();
    await seed(factory, "acct_1", 3);

    // The reload: a brand-new engine over the same account's database, and a server that will
    // never reply.
    const engine = new OhmailEngine({
      adapter: heldAdapter(),
      store: new IndexedDbMirrorStore({ owner: "acct_1", factory }),
    });
    let published = 0;
    engine.subscribe(() => {
      published++;
    });

    expect(engine.read().list("message"), "a fresh engine started with mail in it").toHaveLength(0);

    await engine.hydrate();

    expect(engine.read().list("message"), "the device's copy was not read").toHaveLength(3);
    // THE PROPERTY. Without this the three messages above are in memory and unrenderable.
    expect(published, "the mirror was hydrated and nothing was told").toBeGreaterThan(0);
  });

  it("`start()` publishes the local copy BEFORE it waits on the network", async () => {
    const factory = new IDBFactory();
    await seed(factory, "acct_2", 2);

    const engine = new OhmailEngine({
      adapter: heldAdapter(),
      store: new IndexedDbMirrorStore({ owner: "acct_2", factory }),
    });
    let published = 0;
    engine.subscribe(() => {
      published++;
    });

    /**
     * WAITED FOR, NOT RACED. An earlier version of this drained a fixed number of microtasks and
     * then asserted — which passed, and then failed when the file ran beside another one, because
     * `fake-indexeddb` settles on the task queue and nothing bounded how many turns it needed.
     * A guard that depends on scheduling luck reports the schedule, not the property.
     *
     * So the test waits for the ONE event it is about and gives up after a bound. `start()` is
     * `hydrate(); syncOnce()` and the drain here never settles, so this promise never resolves —
     * which is the point: anything observed below was published by hydration alone.
     */
    const published0 = new Promise<void>((resolve) => {
      engine.subscribe(resolve);
    });
    void engine.start();
    await Promise.race([
      published0,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("start() published nothing before the network answered")),
          2_000,
        ),
      ),
    ]);

    expect(engine.read().list("message"), "start() left the cached mail unread").toHaveLength(2);
    expect(published, "start() hydrated silently and waited on a server that never answers")
      .toBeGreaterThan(0);
  });

  it("a hydration that FAILS can be tried again — one bad read does not brick the tab", async () => {
    /**
     * The scheduler's recovery depends on this: a thrown `load()` leaves `hydrated` false and the
     * next tick calls again. A `hydrate()` that memoized its promise for ever would turn one
     * transient storage error into a mirror that can never be read for the lifetime of the tab,
     * and the panes would sit in the loading state this change just introduced — trading the
     * reported defect for a worse one.
     */
    let attempts = 0;
    const store = {
      ...new (class {})(),
      load: async () => {
        attempts++;
        if (attempts === 1) throw new Error("IndexedDB refused");
      },
      get: () => undefined,
      list: () => [],
      entries: () => [],
      version: () => attempts,
      stampOf: () => attempts,
      stampExcept: () => attempts,
      getCursor: () => "0",
      maxSeq: () => 0,
      applyResponse: async () => {},
      applyChanges: async () => {},
      putLocal: async () => {},
      getMeta: () => undefined,
      setMeta: async () => {},
      resetForBootstrap: async () => {},
      forceCursor: () => {},
      snapshot: () => new Map(),
    };
    const engine = new OhmailEngine({
      adapter: heldAdapter(),
      store: store as never,
    });
    let published = 0;
    engine.subscribe(() => {
      published++;
    });

    await expect(engine.hydrate()).rejects.toThrow("IndexedDB refused");
    /* ONE notice, and it carries the failure, never a mirror: the held composer reads
       `outboxUnreadable()` to say why it is held. */
    expect({ published, unreadable: engine.outboxUnreadable(), mail: engine.read().list("message").length },
      "a failed read published a mirror it never got").toEqual({ published: 1, unreadable: true, mail: 0 });

    await engine.hydrate();
    expect(attempts, "the second attempt was swallowed by a memoized promise").toBe(2);
    expect(published, "the retry that succeeded still told nobody").toBeGreaterThan(0);
  });

  it("concurrent callers read the mirror once", async () => {
    const factory = new IDBFactory();
    await seed(factory, "acct_3", 1);
    const store = new IndexedDbMirrorStore({ owner: "acct_3", factory });
    let loads = 0;
    const realLoad = store.load.bind(store);
    store.load = async () => {
      loads++;
      await realLoad();
    };
    const engine = new OhmailEngine({ adapter: heldAdapter(), store });

    await Promise.all([engine.hydrate(), engine.hydrate(), engine.hydrate()]);

    // A public method's safety must not depend on one caller's latch: the desktop shell, the
    // sidecar and the contract tests all construct this engine themselves.
    expect(loads, "three callers each re-read the whole mirror").toBe(1);
  });
});
