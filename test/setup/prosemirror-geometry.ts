/**
 * PROSEMIRROR ASKS jsdom FOR LAYOUT, AND jsdom HAS NONE. Global, because per-suite was proved
 * not to be enough.
 *
 * ── THE FAILURE THIS PREVENTS IS THE ONE THAT REPORTS SUCCESS ────────────────────────────
 *
 * `focus()` on a ProseMirror editor scrolls the selection into view, which walks a `Range` and
 * asks it for rectangles. jsdom implements neither `getClientRects` nor `getBoundingClientRect`
 * on `Range`, and the throw happens INSIDE a transaction dispatch — after the assertion that
 * triggered it has already passed. The suite therefore reports every test green AND one uncaught
 * exception, which is a failure nobody attributes to anything. One fix exists because of it,
 * and the repo's own note about the three ways a failure reports success here is the same
 * lesson.
 *
 * ── WHY IT IS HERE AND NOT IN EACH SUITE'S `beforeAll` ───────────────────────────────────
 *
 * That was the first attempt, and it left the hole open in exactly the way that is hardest to
 * see: the editor is now mounted by the whole shell, so ANY suite that drives the shell can
 * open a reply — `body-open`, `escape-precedence`, `action-bar`, `ohbox-read-state` and the
 * next one somebody writes. None of those is about the editor, so none of their authors has a
 * reason to think about ProseMirror's geometry.
 *
 * AND IT WAS INTERMITTENT, which is why a per-suite `beforeAll` is not merely incomplete but
 * actively misleading. `Range.prototype` is per WORKER PROCESS and the patch persists once any
 * file applies it, so whether a given suite was protected depended on which file vitest happened
 * to schedule before it in that worker. The same command therefore passed and threw on
 * alternating runs.
 *
 * Measured, not reasoned about. Three runs of `apps/webapp/test apps/desktop/test packages/ui`
 * with the per-suite stubs and no setup file produced 2, 6 and 1 occurrences of
 * `target.getClientRects is not a function` — every one of them uncaught, attached to no test,
 * over a green summary of thousands of tests. Three runs of the same command with this file registered
 * produced 0, 0 and 0. Delete the registration in `vitest.config.ts` and the counts come back.
 *
 * A setup file makes the guarantee unconditional and costs one line per run.
 *
 * ── EMPTY RECTANGLES ARE THE HONEST ANSWER, NOT A LIE THAT SILENCES THE ERROR ────────────
 *
 * A document that was never laid out genuinely occupies no space, so scrolling it into view is
 * genuinely a no-op. This does not pretend anything is visible; it stops a measurement that
 * cannot be taken from being a crash. Nothing in the product reads these values — only
 * ProseMirror's scroll-into-view does — so no assertion is weakened by them.
 */

// `Range` exists only in the jsdom environment; the node-environment suites load this too.
if (typeof Range !== "undefined") {
  const emptyList = (): DOMRectList =>
    Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects = emptyList as never;
  Range.prototype.getBoundingClientRect = (() => new DOMRect()) as never;
}
