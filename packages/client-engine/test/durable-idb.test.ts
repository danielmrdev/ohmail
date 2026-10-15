/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";

import {
  DURABILITY_LOST_EVENT,
  type DurabilityLostDetail,
  durabilityLost,
  durableIdbCommit,
  resetDurabilityForTest,
} from "../src/durable.js";
import { IndexedDbMirrorStore } from "../src/idb.js";
import { faultyFactory } from "./helpers/faulty-idb.js";

/**
 * AN INDEXEDDB WRITE THAT DID NOT COMMIT NOW SAYS SO — the mirror's half of the door.
 *
 * ── WHY THE DOOR IS ON THE TRANSACTION AND NOT ON EACH `put` ────────────────────────────────
 *
 * A `put` returns before anything is on disk; what decides is whether the TRANSACTION committed.
 * A quota refusal, a connection closing under a delete, an explicit `abort()` and a process that
 * stopped mid-write are all one observable state from inside the page — the transaction did not
 * complete — so one verdict at the commit is the whole fact, and a wrapper per write would answer
 * a question IndexedDB does not ask.
 *
 * What was true before: `idb.ts` awaited `txDone`, which rejected. The engine's recovery ran, the
 * records were kept in memory and re-persisted — and nothing anywhere told the reader that this
 * browser had stopped keeping their mail. That is the sentence the door adds; the throw is
 * unchanged, because swallowing it would move the silence one layer down.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · `await commitWrite(tx)` → `await txDone(tx)` in any of `persist`/`transact`/`purge`/`wipe`/
 *    `bindOwner` → "the mirror's refused write reaches the notice" goes red with zero events (and
 *    `test/durable-write-census.test.ts` refuses the file);
 *  · `tx.onabort = () => done(lost(store))` → `done("lost")` → the same case goes red on
 *    `durabilityLost()`;
 *  · dropping the `settled` latch in `durableIdbCommit` → "one lost commit is one event" goes red
 *    with two events for one transaction;
 *  · `if (await durableIdbCommit(...) === "stored") return; throw …` → `return;` (swallowing) →
 *    "the verb still fails loudly" goes red.
 */

let heard: DurabilityLostDetail[] = [];
const listen = (e: Event): void => { heard.push((e as CustomEvent<DurabilityLostDetail>).detail); };

beforeEach(() => {
  resetDurabilityForTest();
  heard = [];
  window.addEventListener(DURABILITY_LOST_EVENT, listen);
});
afterEach(() => {
  window.removeEventListener(DURABILITY_LOST_EVENT, listen);
});

/** A real fake-indexeddb database with one store, for the door's own cells. */
async function openDb(name: string): Promise<IDBDatabase> {
  const factory = new IDBFactory();
  const req = factory.open(name, 1);
  req.onupgradeneeded = () => { req.result.createObjectStore("e"); };
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("open failed"));
  });
}

/**
 * A transaction shim that fires the handlers a real one fires, in a real order.
 *
 * Used for the two cells `fake-indexeddb` cannot stage: an `error` event FOLLOWED BY `abort`,
 * which is what a browser delivers for an unhandled request failure, and a `tx.error` carrying
 * `QuotaExceededError` — the class the store's own fault harness uses, so the double fails the way
 * production fails rather than in a shape of its own.
 */
function scriptedTx(error: DOMException | null, events: Array<"complete" | "abort" | "error">): IDBTransaction {
  const tx = {
    oncomplete: null as (() => void) | null,
    onabort: null as (() => void) | null,
    onerror: null as (() => void) | null,
    error,
  };
  queueMicrotask(() => {
    for (const ev of events) {
      if (ev === "complete") tx.oncomplete?.();
      if (ev === "abort") tx.onabort?.();
      if (ev === "error") tx.onerror?.();
    }
  });
  return tx as unknown as IDBTransaction;
}

describe("the door's IndexedDB arm", () => {
  it("a transaction that COMPLETES resolves stored, and raises nothing", async () => {
    const db = await openDb("door-ok");
    const tx = db.transaction(["e"], "readwrite");
    tx.objectStore("e").put({ a: 1 }, "k");
    expect(await durableIdbCommit(tx, "idb:probe")).toBe("stored");
    expect(heard).toEqual([]);
    expect(durabilityLost()).toBe(false);
    db.close();
  });

  it("a transaction that ABORTS resolves lost, and names the store once", async () => {
    const db = await openDb("door-abort");
    const tx = db.transaction(["e"], "readwrite");
    tx.objectStore("e").put({ a: 1 }, "k");
    tx.abort();
    expect(await durableIdbCommit(tx, "idb:probe")).toBe("lost");
    expect(heard.map((d) => d.store)).toEqual(["idb:probe"]);
    expect(durabilityLost()).toBe(true);
    db.close();
  });

  it("an aborted transaction leaves NOTHING on disk — the verdict is about the whole batch", async () => {
    const db = await openDb("door-atomic");
    const tx = db.transaction(["e"], "readwrite");
    const store = tx.objectStore("e");
    store.put({ a: 1 }, "first");
    store.put({ a: 2 }, "second");
    tx.abort();
    expect(await durableIdbCommit(tx, "idb:probe")).toBe("lost");
    const read = db.transaction(["e"], "readonly").objectStore("e");
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const r = read.getAllKeys();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    expect(keys, "a lost commit must not have left half the batch behind").toEqual([]);
    db.close();
  });

  it("one lost commit is ONE event, even when error and abort both fire", async () => {
    const quota = new DOMException("the quota has been exceeded", "QuotaExceededError");
    const verdict = await durableIdbCommit(scriptedTx(quota, ["error", "abort"]), "idb:probe");
    expect(verdict).toBe("lost");
    expect(heard.map((d) => d.store), "a browser fires error THEN abort for one failure")
      .toEqual(["idb:probe"]);
  });

  it("a QuotaExceededError on the transaction is lost — the door reads the EVENT, not the class", async () => {
    const quota = new DOMException("the quota has been exceeded", "QuotaExceededError");
    const tx = scriptedTx(quota, ["abort"]);
    expect(await durableIdbCommit(tx, "idb:ohmail-mirror")).toBe("lost");
    expect(tx.error?.name, "the double carries the class production carries").toBe("QuotaExceededError");
    expect(heard.map((d) => d.store)).toEqual(["idb:ohmail-mirror"]);
  });

  /**
   * THE MIRROR'S OWN REFUSED WRITE REACHES THE NOTICE — driven through the product verb, over the
   * store's `factory` seam, with the fault harness the outbox tests already use.
   *
   * `arm({ mode: "none", onWrite: () => "quota" })` errors the request and aborts the transaction
   * under it, in that order, which is what a real quota failure does. Nothing about this cell is
   * synthetic except the trigger.
   */
  it("the mirror's refused write reaches the notice, and the verb still fails loudly", async () => {
    const faulty = faultyFactory(new IDBFactory());
    const store = new IndexedDbMirrorStore({ owner: "acct-durable", factory: faulty.factory });
    await store.load();

    // THE CONTROL FIRST: the ordinary write is admitted, silently.
    await store.putLocal("message", "m-ok", { id: "m-ok", subject: "landed" });
    expect(heard, "a write that landed must say nothing").toEqual([]);
    expect(durabilityLost()).toBe(false);

    faulty.arm({ mode: "none", onWrite: () => "quota" });
    // A one-word verdict rather than `.rejects` — a rejection assertion on a live IndexedDB
    // handle has killed the worker in this repo before.
    let outcome = "resolved";
    try {
      await store.putLocal("message", "m-lost", { id: "m-lost", subject: "refused" });
    } catch {
      outcome = "threw";
    }
    faulty.heal();

    expect(faulty.log.broken, "the fault must actually have fired").toBeGreaterThan(0);
    expect(outcome, "a lost mirror write must not report success to the engine").toBe("threw");
    expect(heard.map((d) => d.store)).toEqual(["idb:ohmail-mirror"]);
    expect(durabilityLost()).toBe(true);
    store.close();
  });

  /**
   * THE STORE LABEL CARRIES NO ACCOUNT ID. The detail rides a `window` event anything on the page
   * can hear, and the mirror's DATABASE name is `ohmail-mirror:<account>` — so the label is the
   * mirror's stable name and two accounts' mirrors report identically, deliberately.
   */
  it("the mirror's label names the store and not the account", async () => {
    const faulty = faultyFactory(new IDBFactory());
    const store = new IndexedDbMirrorStore({ owner: "acct-secret-id", factory: faulty.factory });
    await store.load();
    faulty.arm({ mode: "none", onWrite: () => "quota" });
    try {
      await store.setMeta("k", "v");
    } catch { /* the throw is the previous case's subject */ }
    faulty.heal();
    expect(heard.length).toBeGreaterThan(0);
    for (const d of heard) {
      expect(d.store).toBe("idb:ohmail-mirror");
      expect(d.store).not.toContain("acct-secret-id");
    }
    store.close();
  });
});
