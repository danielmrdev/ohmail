/**
 * THE POSITIVE CONTROL — a tree the census MUST find things in.
 *
 * This file is not part of the app. It exists so that the census can be asked the one question
 * every other assertion here takes on trust: **can it find anything at all?**
 *
 * Round three removed `ts.forEachChild(sf, visit)` from the production scan and all eighteen tests
 * stayed green — the clean-tree assertions returned empty because nothing was visited, the
 * "walks a real tree" check counted filenames rather than nodes, and every mutation probe drove a
 * SEPARATE scanner defined inside the test. A census that certifies this app as translated could be
 * switched off and nothing would say so.
 *
 * So the same scanner that runs over `src/` and `app/` is run over this directory, and must report
 * exactly the plants below. Delete the walk, break the fold, neuter a rule — the control goes red.
 *
 * Every plant is deliberate. Keep them in sync with `CONTROL_EXPECTED` in `copy-census.test.ts`;
 * that list is the assertion, and this file is its input.
 */
import { Copy } from "../../../src/copy";

/* PLANT 1 — a module-scope deck read. Frozen in whatever language import order decided. */
const FROZEN_TABLE = { title: Copy.reads };

/* PLANT 2 — the same, one indirection deeper: an IIFE runs at import too. */
const FROZEN_IIFE = (() => Copy.receipts)();

/* PLANT 3 — a comma-expression IIFE, which the first detector did not recognise. */
const FROZEN_COMMA = (0, () => Copy.screener)();

/* PLANT 4 — `.call()`, likewise immediate. */
const FROZEN_CALL = function () { return Copy.settings; }.call(null);

/* PLANT 5 — a dynamic concatenation whose literal half is a sentence. */
const DYNAMIC = "Please try again in " + String(3) + " minutes";

/* PLANT 6 — prose nested inside a dynamic operand, which the fold used to swallow whole. */
const NESTED = "Prefix " + (Math.random() > 0.5 ? "a whole English clause" : String(1));

export function PlantedScreen({ ok }: { ok: boolean }) {
  void FROZEN_TABLE; void FROZEN_IIFE; void FROZEN_COMMA; void FROZEN_CALL;
  void DYNAMIC; void NESTED;
  return (
    <View>
      {/* PLANT 7 — bare JSX text. */}
      <Txt>Nothing here yet at all.</Txt>
      {/* PLANT 8 — a string through a JSX expression. */}
      <Txt>{"Retry"}</Txt>
      {/* PLANT 9 — a conditional between two strings, in a child expression. */}
      <Txt>{ok ? "Ready now" : "Still waiting"}</Txt>
      {/* PLANT 10 — a callback's returned string, reached through a chained call. */}
      <Txt>{[1, 2].map(() => "No mail here").join("")}</Txt>
      {/* PLANT 11 — a one-word label, which only the rendering-position rule can catch. */}
      <Row label="Receipts" />
      {/* NOT A PLANT — an attribute callback's argument. Nobody reads it, and a census that
          reported it would be crying wolf; the control asserts its ABSENCE. */}
      <Tap onPress={() => log("debug")} />
    </View>
  );
}

/* NOT A PLANT — a thrown developer fault, directly and one indirection away. */
const FAULT = "this sentence is for a developer";
export function boom(): never { throw new Error(FAULT); }

declare const View: (p: { children?: unknown }) => unknown;
declare const Txt: (p: { children?: unknown }) => unknown;
declare const Row: (p: { label: string }) => unknown;
declare const Tap: (p: { onPress: () => void }) => unknown;
declare function log(s: string): void;

/* ── SENTENCES ASSEMBLED BY THE MARKUP ───────────────────────────────────────────────────────
   Punctuation typed between two rendered values. Every piece is legitimate alone, which is why
   the census could not see the Screener's sender note; the JOIN is the defect. Deliberately free
   of words, so these plants do not disturb the prose expectations above. */
export const Joined = ({ a, b }: { a: string; b: string }) => (
  <View>
    {/* PLANT a colon between two values */}
    <Txt>{a}: {b}</Txt>
    {/* PLANT a dash between two values */}
    <Txt>{a} — {b}</Txt>
    {/* PLANT a comma with an element on one side */}
    <Txt>{a}{" "}<Txt>{b}</Txt>, {a}</Txt>
  </View>
);

export const NotJoined = ({ a, b }: { a: string; b: string }) => (
  <View>
    {/* NON-PLANT whitespace between values is layout, not a sentence */}
    <Txt>{a} {b}</Txt>
    {/* NON-PLANT punctuation with nothing on the far side */}
    <Txt>{a}:</Txt>
    {/* NON-PLANT a quoted literal is prose, and the prose rule owns it */}
    <Txt>{"x"}: {b}</Txt>
  </View>
);

/* ── THE REMAINING WAYS A FUNCTION RUNS AT IMPORT ────────────────────────────────────────────
   `isImmediatelyInvoked` claims five shapes. Three of them had no plant, so three of the five
   were assertions about code nobody had watched work. Each of these freezes the language at
   module-initialisation time exactly as a bare `Copy.x` at module scope does. */

/* PLANT 12 — `.apply()`, the sibling of the `.call()` above. */
export const p12 = (() => Copy.moveLabel).apply(null);

/* PLANT 13 — a tagged template invokes its tag. */
export const p13 = ((s: TemplateStringsArray) => `${String(s[0])}${Copy.scopeSender}`)`x`;

/* PLANT 14 — `bind` alone defers, but a bound function that is then CALLED runs now. */
export const p14 = (() => Copy.scopeDomain).bind(null)();

/* ── AND THE TWO THAT MUST NOT BE FLAGGED ──────────────────────────────────────────────────── */

/* NOT A PLANT — `bind` with no call. Nothing has run; the read happens whenever somebody calls it. */
export const nBind = (() => Copy.doorbellRest).bind(null);

/* NOT A PLANT — a read inside a method body. It runs when the method is called, which is the
   ordinary live read every screen does. */
export class Later {
  say(): string { return (() => Copy.facePaper)(); }
}
