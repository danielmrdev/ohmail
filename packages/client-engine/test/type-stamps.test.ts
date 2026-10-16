import { describe, expect, it } from "vitest";
import { MemoryMirrorStore } from "../src/store.js";
import { OhmailEngine } from "../src/engine.js";
import { messagesByDateDesc } from "../src/selectors.js";
import type { EntityReader } from "../src/store.js";

/**
 * PER-TYPE STAMPS — what a derivation asks instead of "has anything at all changed".
 *
 * `version()` moves for ANY record write, and on this client most writes are bodies: an open
 * writes three `message_body` records (the loading marker, the answer, the cache trim) and the
 * eager pass writes one per message. Keyed on it, every whole-mirror pass the window holds
 * rebuilt for a fact none of them reads — counted against the real shell at TWENTY whole-mirror
 * passes for one body publish, against twenty-three for a full `/sync` page of messages.
 *
 * The property under test is the one that makes that safe: a stamp moves when a record of its
 * type moves and at no other time, and `stampExcept` is a DENY list so a type nobody named is
 * watched rather than silently dropped.
 */

const ISO = "2026-08-04T09:00:00.000Z";
const msg = (id: string, seq: number, over: Record<string, unknown> = {}) => ({
  type: "message", op: "create", id, seq, updatedAt: ISO,
  entity: { id, folder: "INBOX", date: ISO, subject: id, ...over },
});
const resp = (creates: unknown[], cursor: string) => ({
  changes: { creates, updates: [], moves: [], deletes: [] },
  cursor, hasMore: false, serverTime: ISO,
}) as never;

describe("a stamp moves for its own type and nothing else", () => {
  it("a body write moves the body stamp and leaves every other type standing", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyResponse(resp([msg("m1", 1), msg("m2", 2)], "c2"));

    const messageAt = store.stampOf("message");
    const ruleAt = store.stampOf("rule");
    const derivedAt = store.stampExcept(["message_body"]);

    await store.putLocal("message_body", "m1", { state: "ready", text: "hello", html: null });

    expect(store.version(), "the global version must still move — a body IS a change")
      .toBeGreaterThan(0);
    expect(store.stampOf("message_body"), "the body's own stamp did not move")
      .toBeGreaterThan(0);
    // THE PROPERTY. Everything the window derives from is exactly where it was.
    expect(store.stampOf("message"), "a body write moved the MESSAGE stamp").toBe(messageAt);
    expect(store.stampOf("rule"), "a body write moved the RULE stamp").toBe(ruleAt);
    expect(store.stampExcept(["message_body"]), "a body write moved the derived stamp")
      .toBe(derivedAt);
  });

  it("a message page moves the message stamp AND the derived stamp", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyResponse(resp([msg("m1", 1)], "c1"));
    const messageAt = store.stampOf("message");
    const derivedAt = store.stampExcept(["message_body"]);

    await store.applyResponse(resp([msg("m2", 2)], "c2"));

    expect(store.stampOf("message")).toBeGreaterThan(messageAt);
    expect(store.stampExcept(["message_body"])).toBeGreaterThan(derivedAt);
  });

  it("an EMPTY page moves neither — the idle poll's rule, unchanged", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyResponse(resp([msg("m1", 1)], "c1"));
    const at = store.stampExcept(["message_body"]);
    const v = store.version();

    await store.applyResponse(resp([], "c2"));

    expect(store.version(), "an empty page bumped the version").toBe(v);
    expect(store.stampExcept(["message_body"])).toBe(at);
  });

  /**
   * THE DENY LIST IS A DENY LIST. Naming one type must not make the others invisible — an
   * allow-list spelling of this would pass the case above and fail here, which is the whole
   * reason the shell asks the question this way round.
   */
  it("stampExcept still sees every type it was not told to ignore", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyResponse(resp([msg("m1", 1)], "c1"));
    const at = store.stampExcept(["message_body"]);

    await store.applyResponse(resp([{
      type: "tag", op: "create", id: "t1", seq: 9, updatedAt: ISO, entity: { id: "t1", name: "Work" },
    }], "c9"));

    expect(store.stampOf("tag"), "a tag write did not move the tag stamp").toBeGreaterThan(0);
    expect(store.stampExcept(["message_body"]), "a type nobody ignored went unseen")
      .toBeGreaterThan(at);
  });

  /**
   * A PRUNE'S BODY CASCADE. Pruning a message also removes its body, and the caller named only
   * the message: a stamp taken from the caller's own list would leave every body reader holding
   * a stamp from before the bodies went.
   */
  it("a message prune stamps the bodies it cascaded away", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyResponse(resp([msg("m1", 1)], "c1"));
    await store.putLocal("message_body", "m1", { state: "ready", text: "x", html: null });
    const bodyAt = store.stampOf("message_body");

    await store.prune([{ type: "message", id: "m1" }]);

    expect(store.list("message_body"), "the cascade did not run").toHaveLength(0);
    expect(store.stampOf("message_body"), "the cascaded body type was not stamped")
      .toBeGreaterThan(bodyAt);
  });

  /** A wipe moves every type — including one holding no rows, which the map cannot name. */
  it("a bootstrap reset moves the stamp of a type that holds nothing", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const emptyAt = store.stampOf("folder");
    await store.resetForBootstrap();
    expect(store.stampOf("folder"), "the wipe left an empty type's stamp where it was")
      .toBeGreaterThan(emptyAt);
  });
});

describe("the shared date order is not re-derived for a body", () => {
  /**
   * THE ONE WHOLE-MIRROR DERIVATION INSIDE THE ENGINE, and it had the same defect the shell had.
   *
   * `messagesByDateDesc` caches one date-desc order per reader, and every whole-mirror selector
   * filters that one array. Keyed on `version()` it MISSED on every body publish — and a miss
   * here is not a re-sort avoided, it is a fresh `list()` of the whole mirror, a Map of every id
   * and a walk of every row, to arrive back at the order it already held.
   *
   * Asserted by ARRAY IDENTITY rather than by contents: contents are equal either way, which is
   * exactly how this cost stayed invisible. A guard on contents passes over the defect.
   */
  it("answers the SAME array across a body publish, and a fresh one across a message page", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = new OhmailEngine({
      adapter: {
        sync: async () => resp([], "c0"),
        mutate: async () => ({ changes: [], seq: null }),
        fetchBody: async () => ({ text: "", html: null, loadedRemoteContent: false }),
        fetchBodies: async () => [],
      } as never,
      store,
    });
    await engine.start();
    await store.applyResponse(resp([msg("m1", 1), msg("m2", 2)], "c2"));

    const reader = engine.read();
    const first = messagesByDateDesc(reader);
    expect(first).toHaveLength(2);

    await store.putLocal("message_body", "m1", { state: "ready", text: "x", html: null });
    expect(messagesByDateDesc(engine.read()), "a body publish re-derived the whole mirror's order")
      .toBe(first);

    await store.applyResponse(resp([msg("m3", 3)], "c3"));
    expect(messagesByDateDesc(engine.read()), "an arriving message did NOT re-derive the order")
      .not.toBe(first);
  });
});

describe("the reader the shell actually holds carries the stamps", () => {
  /**
   * The overlay reader is what `engine.read()` answers, and a wrapper that dropped these would
   * not fail loudly — it would answer a stamp that never moves, and the window would hold a
   * projection of a mailbox that had changed. Asked through the ENGINE rather than the class,
   * because the class is private and the engine's answer is what the shell keys on.
   */
  it("engine.read() answers a per-type stamp, and a body write leaves the message one alone", async () => {
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({
      adapter: {
        sync: async () => resp([], "c0"),
        mutate: async () => ({ changes: [], seq: null }),
        fetchBody: async () => ({ text: "", html: null, loadedRemoteContent: false }),
        fetchBodies: async () => [],
      } as never,
      store,
    });
    await engine.start();
    await store.applyResponse(resp([msg("m1", 1)], "c1"));

    const reader: EntityReader = engine.read();
    const messageAt = reader.stampOf("message");
    const derivedAt = reader.stampExcept(["message_body"]);
    expect(messageAt, "the overlay reader answered a resting stamp").toBeGreaterThan(0);

    await store.putLocal("message_body", "m1", { state: "ready", text: "x", html: null });

    expect(engine.read().stampOf("message"), "a body moved the message stamp through the overlay")
      .toBe(messageAt);
    expect(engine.read().stampExcept(["message_body"]), "a body moved the derived stamp")
      .toBe(derivedAt);
    expect(engine.read().version(), "the global version did NOT move for a body")
      .toBeGreaterThan(0);
  });
});
