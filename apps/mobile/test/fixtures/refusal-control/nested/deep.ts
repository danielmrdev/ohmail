/**
 * PLANTS THE WALK ONLY REACHES IF IT RECURSES, and the two key shapes it used to skip.
 *
 * `app/` produces no refusal today; this file is what proves the walk would find the first one,
 * because a root nobody has watched find something is the same as a root that is not scanned.
 */
import { refuse as r, sayRefusal as say } from "../../../../src/refusal";

declare const closed: boolean;

/* PLANT an ALIASED builder — the callee text is `r`, not `refuse`. */
export const a1 = r("notPairedHere");

/* PLANT a CONDITIONAL key: two keys from one call, both of which must be checked. */
export const a2 = r(closed ? "pairNotStoredClosed" : "pairNotStoredOpen", "detail");

/* PLANT a key that cannot be read from the source at all — it must be REPORTED, not dropped. */
declare const dynamic: "notPairedHere";
export const a3 = r(dynamic);

/* ── THE SAME ALIAS, AGAINST THE TWO AST GUARDS ──────────────────────────────────────────────
   Both matched a callee by the literal text `refuse`, so an aliased import hid every call in
   its file from them while the census above counted it — the same gap in two of three places.
   These plants carry the alias on the BUILDER and on the FORMATTER at once. */

declare const inner2: unknown;

/* PLANT formatted copy inside an aliased refusal, through an aliased renderer. */
export const a4 = r("outer", say(inner2 as never));

/* PLANT a stringified catch variable inside an aliased refusal. */
export function a5(): unknown {
  try { return null; } catch (err) { return r("outer", String(err)); }
}
