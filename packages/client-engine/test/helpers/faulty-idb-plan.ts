/**
 * The shape of an injected storage fault — separated from the wrapper so a test can name a plan
 * without pulling in the wrapper's IndexedDB internals.
 */

/** What the plan says about one object-store write. */
export type WriteVerdict =
  /** Let it through to the real store. */
  | "pass"
  /** The request errors with `QuotaExceededError` and the transaction aborts under it. */
  | "quota"
  /** The write is never issued and the transaction aborts — "the first op landed, the second did not". */
  | "abort";

export interface FaultPlan {
  /** True while a plan is armed; read per transaction. */
  armed: () => boolean;
  /**
   * `death` makes every armed readwrite transaction never complete AND never abort, which is what
   * a process that stopped mid-write looks like from inside it. `none` leaves completion alone and
   * lets {@link FaultPlan.onWrite} decide per operation.
   */
  mode: "none" | "death";
  /**
   * Called for each `put`/`delete` in an armed readwrite transaction with the record key it
   * carries (`"<type>:<id>"`, the store's own encoding) and the running index of writes seen
   * since the plan was armed — so "abort after the Nth" is
   * `(_op, _key, n) => (n < N ? "pass" : "abort")`.
   *
   * THE KEY IS NOT A CONVENIENCE. A plan that answers "quota" to everything also breaks the
   * `/sync` flush and the cursor write, and the test then fails in `applyResponse` for a reason
   * that has nothing to do with the verb it names — which is how a red becomes unreadable. Every
   * case in the table targets the rows it is about, and lets the rest of the store work.
   */
  onWrite?: (op: "put" | "delete", key: string, n: number) => WriteVerdict;
}
