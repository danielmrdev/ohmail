/**
 * FAULT INJECTION AT THE TRANSACTION, NEVER AT THE STORE'S METHOD.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────
 *
 * The tests it replaces did this:
 *
 *     store.putLocal = () => Promise.reject(new Error("quota"));
 *
 * which rejects WITHOUT MUTATING MEMORY — the exact inverse of the real store, whose `putLocal`
 * publishes the row to `records` and only then awaits a flush that may fail. Every assertion
 * about "what a refused write leaves behind" was therefore made against a store that behaves in
 * the one way the real one does not, and five review findings lived in that gap: the double could
 * not produce the twins, could not produce a row live in memory and absent from disk, and could
 * not express "the first operation landed and the second aborted" at all.
 *
 * So faults enter through the seam the store already exposes to its host — the `factory` option —
 * and they are IndexedDB's own faults: a request that errors, a transaction that aborts partway,
 * a transaction that never completes. The third is the interesting one, because IndexedDB makes
 * "the process died mid-transaction" and "the transaction aborted" the same observable state; a
 * test that can produce one has produced the other, and that equivalence is the whole reason to
 * inject here rather than anywhere else.
 *
 * The wrapper is plain object delegation rather than a Proxy: `requestDone`/`txDone` in `idb.ts`
 * touch only `onsuccess`/`onerror`/`onabort`/`oncomplete`/`result`/`error`, and the store's own
 * code touches only `transaction()`, `objectStore()`, `put`, `delete`, `get`, `clear` and
 * `objectStoreNames`. Anything outside that surface is passed straight through to the real object.
 */
import type { FaultPlan } from "./faulty-idb-plan.js";

export type { FaultPlan };

/** A live count of what the plan has seen, so a test can assert the fault actually fired. */
export interface FaultLog {
  /** Object-store writes (`put` + `delete`) that reached the real store. */
  applied: number;
  /** Writes the plan intercepted. */
  intercepted: number;
  /** Transactions the plan aborted or hung. */
  broken: number;
}

interface Ctl {
  plan: FaultPlan;
  log: FaultLog;
}

/**
 * A `put`/`delete`/`get` request that never reaches the database and reports the plan's failure.
 *
 * `requestDone` reads `onerror` and `error`, so those are the only two that must be real. The
 * error is a `DOMException` with the name IndexedDB actually uses, because the store's own
 * classification — and any future one — reads `.name`, not the message.
 */
function failedRequest(err: DOMException): IDBRequest {
  const req = {
    onsuccess: null as ((this: IDBRequest, ev: Event) => unknown) | null,
    onerror: null as ((this: IDBRequest, ev: Event) => unknown) | null,
    error: err,
    result: undefined,
    readyState: "done",
  } as unknown as IDBRequest;
  // Asynchronously, as a real request would: a handler assigned on the line after the call must
  // still see the event. `queueMicrotask` rather than `setTimeout` keeps it inside the same
  // transaction turn, which is where IndexedDB would deliver it.
  queueMicrotask(() => {
    req.onerror?.call(req, new Event("error"));
  });
  return req;
}

/**
 * ABORT SYNCHRONOUSLY, NOT IN A MICROTASK — and this cost a false green.
 *
 * An intercepted write issues NO real request. A transaction with no pending requests commits as
 * soon as control returns to the event loop, so a `queueMicrotask(() => tx.abort())` can run after
 * the transaction has already finished: the writes issued BEFORE the intercepted one are durably
 * committed, and the abort throws harmlessly into a `catch`. The fault then reads as "the delete
 * failed" when what actually happened is "the put succeeded and nothing was rolled back".
 *
 * That is precisely the half-applied state these tests exist to prove impossible, manufactured by
 * the harness rather than by the code. A real quota failure aborts the transaction there and then,
 * so this does too.
 */
function abortNow(tx: IDBTransaction): void {
  try { tx.abort(); } catch { /* already settled */ }
}

function wrapStore(real: IDBObjectStore, tx: IDBTransaction, ctl: Ctl): IDBObjectStore {
  const write = (op: "put" | "delete", key: unknown, run: () => IDBRequest): IDBRequest => {
    const verdict = ctl.plan.onWrite?.(
      op, typeof key === "string" ? key : String(key), ctl.log.applied + ctl.log.intercepted,
    );
    if (verdict === undefined || verdict === "pass") {
      ctl.log.applied += 1;
      return run();
    }
    ctl.log.intercepted += 1;
    if (verdict === "quota") {
      ctl.log.broken += 1;
      // A real quota failure errors the REQUEST and aborts the TRANSACTION. Both, in that order:
      // a test that only saw the request error would be asserting against a half-failure the
      // browser never produces.
      const err = new DOMException("the quota has been exceeded", "QuotaExceededError");
      abortNow(tx);
      return failedRequest(err);
    }
    // "abort": the write is simply not issued and the transaction goes down under it — the
    // "first op landed, second aborted" shape, which is the one no whole-call double can express.
    ctl.log.broken += 1;
    abortNow(tx);
    return failedRequest(new DOMException("the transaction was aborted", "AbortError"));
  };

  const shim = {
    put: (value: unknown, key?: IDBValidKey) => write("put", key, () => real.put(value, key)),
    delete: (key: IDBValidKey | IDBKeyRange) => write("delete", key, () => real.delete(key)),
    get: (key: IDBValidKey | IDBKeyRange) => real.get(key),
    getAll: (q?: IDBValidKey | IDBKeyRange | null, n?: number) => real.getAll(q, n),
    getAllKeys: (q?: IDBValidKey | IDBKeyRange | null, n?: number) => real.getAllKeys(q, n),
    clear: () => real.clear(),
    openCursor: (q?: IDBValidKey | IDBKeyRange | null, d?: IDBCursorDirection) => real.openCursor(q, d),
    count: (q?: IDBValidKey | IDBKeyRange) => real.count(q),
    get name() { return real.name; },
    get keyPath() { return real.keyPath; },
    get indexNames() { return real.indexNames; },
    get transaction() { return tx; },
    get autoIncrement() { return real.autoIncrement; },
  };
  return shim as unknown as IDBObjectStore;
}

/**
 * THE DEAD-PROCESS TRANSACTION: it never completes and never aborts on its own.
 *
 * `txDone` awaits `oncomplete`/`onabort`/`onerror`. A transaction that fires none of them leaves
 * the store's `await` pending for ever — which is precisely what a process that stopped mid-write
 * looks like from inside that process. The test then abandons the store and reboots over the same
 * database, and the assertion is about what the NEXT process finds, not about this promise.
 *
 * The real transaction is aborted underneath so the database is left in the state a killed
 * process leaves it in — nothing this transaction wrote is committed.
 */
function wrapTx(real: IDBTransaction, ctl: Ctl): IDBTransaction {
  const dead = ctl.plan.mode === "death";
  if (dead) {
    ctl.log.broken += 1;
    queueMicrotask(() => { try { real.abort(); } catch { /* already settled */ } });
  }
  const shim = {
    objectStore: (name: string) => wrapStore(real.objectStore(name), shim as unknown as IDBTransaction, ctl),
    abort: () => real.abort(),
    commit: () => real.commit?.(),
    get db() { return real.db; },
    get error() { return real.error; },
    get mode() { return real.mode; },
    get objectStoreNames() { return real.objectStoreNames; },
    // The handlers. In `death` mode NOTHING is ever forwarded: the store's `txDone` promise stays
    // pending, exactly as it would in a process that stopped. Otherwise they are wired straight
    // through to the real transaction.
    set oncomplete(fn: ((ev: Event) => unknown) | null) { if (!dead) real.oncomplete = fn as never; },
    get oncomplete() { return dead ? null : (real.oncomplete as never); },
    set onabort(fn: ((ev: Event) => unknown) | null) { if (!dead) real.onabort = fn as never; },
    get onabort() { return dead ? null : (real.onabort as never); },
    set onerror(fn: ((ev: Event) => unknown) | null) { if (!dead) real.onerror = fn as never; },
    get onerror() { return dead ? null : (real.onerror as never); },
    addEventListener: (...a: unknown[]) => (real.addEventListener as never as (...x: unknown[]) => void)(...a),
    removeEventListener: (...a: unknown[]) => (real.removeEventListener as never as (...x: unknown[]) => void)(...a),
  };
  return shim as unknown as IDBTransaction;
}

function wrapDb(real: IDBDatabase, ctl: Ctl): IDBDatabase {
  const shim = {
    transaction: (names: string | string[], mode?: IDBTransactionMode) => {
      const tx = real.transaction(names, mode);
      // READ-ONLY TRANSACTIONS ARE NEVER BROKEN. `load()` and the fence's own `get` run through
      // here, and a plan that killed them would be testing the hydrate path instead of the write
      // path — a test that fails for a reason other than the one it names is worth nothing.
      if (mode !== "readwrite") return tx;
      if (!ctl.plan.armed()) return tx;
      return wrapTx(tx, ctl);
    },
    close: () => real.close(),
    createObjectStore: (n: string, o?: IDBObjectStoreParameters) => real.createObjectStore(n, o),
    deleteObjectStore: (n: string) => real.deleteObjectStore(n),
    get name() { return real.name; },
    get version() { return real.version; },
    get objectStoreNames() { return real.objectStoreNames; },
    set onversionchange(fn: ((ev: Event) => unknown) | null) { real.onversionchange = fn as never; },
    get onversionchange() { return real.onversionchange as never; },
    set onclose(fn: ((ev: Event) => unknown) | null) { real.onclose = fn as never; },
    get onclose() { return real.onclose as never; },
    addEventListener: (...a: unknown[]) => (real.addEventListener as never as (...x: unknown[]) => void)(...a),
    removeEventListener: (...a: unknown[]) => (real.removeEventListener as never as (...x: unknown[]) => void)(...a),
  };
  return shim as unknown as IDBDatabase;
}

export interface FaultyFactory {
  factory: IDBFactory;
  log: FaultLog;
  /** Arm the plan. Until this is called every write goes straight through. */
  arm: (plan: Omit<FaultPlan, "armed">) => void;
  /** Disarm — "storage recovers", which every case in the table needs. */
  heal: () => void;
}

/**
 * Wrap a real `IDBFactory` so the store opened over it can be made to fail on demand.
 *
 * The plan is armed AFTER `start()`/`hydrate()`, never before: a store that cannot open is a
 * different test, and arming early makes every case fail in the bootstrap for a reason that has
 * nothing to do with the verb under test.
 */
export function faultyFactory(real: IDBFactory): FaultyFactory {
  const log: FaultLog = { applied: 0, intercepted: 0, broken: 0 };
  let plan: Omit<FaultPlan, "armed"> | null = null;
  const ctl: Ctl = {
    log,
    plan: {
      armed: () => plan !== null,
      get mode() { return plan?.mode ?? "none"; },
      onWrite: (op, key, n) => plan?.onWrite?.(op, key, n) ?? "pass",
    } as FaultPlan,
  };

  const shim = {
    open: (name: string, version?: number) => {
      const req = real.open(name, version);
      // `requestDone` resolves on `onsuccess` and reads `.result`; the store then uses that
      // handle for every transaction. Substituting the wrapper at `result` is the whole hook.
      const out = {
        get onsuccess() { return req.onsuccess; },
        set onsuccess(fn) { req.onsuccess = fn; },
        get onerror() { return req.onerror; },
        set onerror(fn) { req.onerror = fn; },
        get onupgradeneeded() { return req.onupgradeneeded; },
        set onupgradeneeded(fn) { req.onupgradeneeded = fn; },
        get onblocked() { return (req as IDBOpenDBRequest).onblocked; },
        set onblocked(fn) { (req as IDBOpenDBRequest).onblocked = fn; },
        get error() { return req.error; },
        get readyState() { return req.readyState; },
        get transaction() { return req.transaction; },
        get result() { return wrapDb(req.result, ctl); },
        addEventListener: (...a: unknown[]) => (req.addEventListener as never as (...x: unknown[]) => void)(...a),
        removeEventListener: (...a: unknown[]) => (req.removeEventListener as never as (...x: unknown[]) => void)(...a),
      };
      return out as unknown as IDBOpenDBRequest;
    },
    deleteDatabase: (name: string) => real.deleteDatabase(name),
    databases: () => (real.databases ? real.databases() : Promise.resolve([])),
    cmp: (a: unknown, b: unknown) => real.cmp(a, b),
  };

  return {
    factory: shim as unknown as IDBFactory,
    log,
    arm: (p) => { plan = p; },
    heal: () => { plan = null; },
  };
}
