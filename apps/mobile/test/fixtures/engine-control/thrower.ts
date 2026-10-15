/**
 * THE POSITIVE CONTROL FOR THE ENGINE-THROW GUARD.
 *
 * That guard shipped with no plant at all: it scanned the real `src/engine`, found it clean, and
 * asserted a node count. A guard that has only ever been run over code with nothing in it has not
 * been seen to work — and its first version matched the single spelling `throw new Error(...)`,
 * so three other ways to throw the same English sentence walked past it.
 *
 * Not part of the app. Excluded from the app's tsconfig; nothing imports it.
 */
declare class StoreFault { constructor(code: string, message: string); }

/* ── PLANTS: each reaches `faultDetail` as somebody else's error and is quoted in English ──── */
export function p1(): never { throw new Error("the mirror would not open"); }        // PLANT
export function p2(): never { throw Error("the mirror would not open"); }            // PLANT no `new`
export function p3(): never { throw new TypeError("the account id is not a string"); } // PLANT
export function p4(): never {
  const e = new Error("held in a variable first");                                    // PLANT
  throw e;
}

/* ── NON-PLANTS ───────────────────────────────────────────────────────────────────────────── */
export function n1(): never { throw new StoreFault("mirror_not_deleted", "detail for a trace"); }
export function n2(): unknown {
  try { return null; } catch (err) { throw err; }        // a re-throw carries what it caught
}
