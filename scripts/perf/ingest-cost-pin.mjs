/**
 * WHAT ONE INGESTED MESSAGE COSTS THE STORE, in one place, because two instruments read it.
 *
 * `apps/worker/test/ingest-round-trips.test.ts` is the ratchet: it counts statements at PGlite's
 * own doors and may only ever FALL. A private CPU harness is the portable
 * instrument that answers the same question on a Windows guest, where no vitest runs. Two
 * instruments with two literals drift silently and the drift reads as a finding, so both import
 * these — and `test/ingest-cpu-harness-agrees.test.ts` refuses a harness that disagrees with the
 * pin by more than the tolerance below.
 */

/** Measured 25.0 marginal statements per message (40 to 200 in one cycle, no classifier). */
export const INGEST_STATEMENTS_PER_MESSAGE = 25.0;
/** The ratchet's bound, half a statement above the measurement. A RULING, not drift — see the ratchet. */
export const INGEST_STATEMENTS_CEILING = 25.5;
/** Transactions per message, and its bound. */
export const INGEST_TRANSACTIONS_PER_MESSAGE = 2.0;
export const INGEST_TRANSACTIONS_CEILING = 2.1;
/**
 * How far the harness may sit from the pin and still be the same instrument: the tolerance the
 * harness's two independent agreements with the import rig were reported at. It is a RELATIVE
 * tolerance because the quantity is a rate, and it is deliberately tighter than the ratchet's own
 * half-statement headroom — a harness that has stopped driving a pass loses whole statements.
 */
export const HARNESS_AGREEMENT_TOLERANCE = 0.002;
