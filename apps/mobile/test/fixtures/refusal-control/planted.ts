/**
 * THE POSITIVE CONTROL FOR THE NESTED-COPY GUARD.
 *
 * The guard reads the shipped source for a `refuse(…)` whose ARGUMENTS format copy — the shape
 * that froze the inner half of a sentence in the language it was produced in. A guard nobody has
 * watched find something is not evidence, and the guard it replaced was green over the real
 * defect for its whole life, so it is pointed at this file too: every PLANT here must be found,
 * and every NON-PLANT must be left alone.
 *
 * Not part of the app. Excluded from the app's tsconfig; nothing imports it.
 */
declare const refuse: (key: string, ...args: unknown[]) => unknown;
declare const sayRefusal: (r: unknown) => string;
declare const Copy: Record<string, string> & { pairFailed: (a: string) => string };
declare const inner: unknown;
declare const err: unknown;

/* ── PLANTS: each of these formats copy inside a refusal's arguments ───────────────────────── */
export const p1 = refuse("outer", sayRefusal(inner));                 // PLANT the original defect
export const p2 = refuse("outer", Copy.notPairedHere);                // PLANT a deck read
export const p3 = refuse("outer", "a", Copy.pairFailed("x"));         // PLANT past the first arg
export const p4 = refuse("outer", `held: ${sayRefusal(inner)}`);      // PLANT inside a template
export const p5 = refuse("outer", [Copy.notPairedHere].join(""));     // PLANT nested in a call

/* ── NON-PLANTS: formatting copy is normal everywhere else ─────────────────────────────────── */
export const n1 = sayRefusal(inner);                                  // rendering, not producing
export const n2 = refuse("outer", String(err));                       // a platform diagnostic
export const n3 = refuse("outer", inner as never);                    // the nested refusal itself
export const n4 = Copy.notPairedHere;                                 // a plain read

/* ── A CAUGHT ERROR STRINGIFIED STRAIGHT INTO A REFUSAL ──────────────────────────────────────
   A failure this app authored carries a code and the deck words it; `String(err)` on one of
   those puts an English sentence inside a German one. `faultDetail` is the seam that tells the
   two apart, so a catch variable must reach a refusal through it. */
declare const faultDetail: (e: unknown) => unknown;
declare const res: { status: number };
declare const n: number;

export function q1(): unknown {
  try { return null; } catch (err) { return refuse("outer", String(err)); }   // PLANT
}
export function q2(): unknown {
  try { return null; } catch (e) { return refuse("outer", "a", String(e)); }  // PLANT past arg 1
}
export function q3(): unknown {
  try { return null; } catch (err) { return refuse("outer", `${String(err)}`); } // PLANT in a hole
}
export function q4(): unknown {
  try { return null; } catch (err) { return refuse("outer", faultDetail(err)); } // NON-PLANT
}
export function q5(): unknown {
  try { return null; } catch (err) { void err; return refuse("outer", String(n)); } // NON-PLANT
}
export const q6 = refuse("outer", String(res.status));                          // NON-PLANT

/* ── COPY HANDED TO A REACT SETTER ───────────────────────────────────────────────────────────
   The shape the `refuse(...)` guards cannot see: state that holds WORDS. */
declare const setProblem: (v: unknown) => void;
declare const setOk: (v: unknown) => void;

export function s1(): void { setProblem(Copy.notPairedHere); }              // PLANT
export function s2(): void { setProblem({ why: Copy.pairFailed("x") }); }   // PLANT, one deeper
export function s3(): void { setOk(refuse("notPairedHere")); }              // NON-PLANT, a refusal

/* PLANT — a deck read reaching a setter through a local name; the argument is just an identifier. */
export function s4(): void { const words = Copy.notPairedHere; setProblem(words); }
