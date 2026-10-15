/**
 * THE ONE WAY A TEST CROSSES THE FIRST-PAINT SEAM. Three deferrals live behind it: the Screener
 * queue's first derivation (`shell/first-paint.ts` — a macrotask under jsdom, which serves no
 * `requestIdleCallback`), the lazy Settings/Compose chunks, and the editor's own (`React.lazy`,
 * module promises). One timer tick settles the first, the act rounds after it commit the rest —
 * never a sleep, and fake-timer suites run the due timers rather than waiting for a real tick.
 */
import * as React from "react";
import { vi } from "vitest";

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/**
 * THE EDITOR'S OWN SEAM, for a test that opens one. `RichEditorLazy` defers `RichEditor.tsx`, so
 * the surface renders its frame until that module is evaluated — real module I/O in vitest, which
 * no number of microtask rounds awaits. Awaited here, then the act rounds commit the swap.
 */
export async function settleEditor(): Promise<void> {
  await import("../app/shell/RichEditor.js");
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

export async function settleFirstPaint(): Promise<void> {
  // The lazy panes' modules, resolved deterministically: a dynamic import is real module I/O in
  // vitest, which no number of microtask rounds awaits. Once evaluated, `React.lazy`'s own
  // factory promise resolves on the microtask queue the act rounds below drain.
  await Promise.all([
    import("../app/views/SettingsView.js"),
    import("../app/views/ComposeView.js"),
    // The editor is the third: `RichEditorLazy` defers it behind its own boundary, so a reply,
    // a signature row and the Reply Run all render their frame until this module is evaluated.
    import("../app/shell/RichEditor.js"),
  ]);
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  // The settle's own re-render, and a pending lazy boundary's retry — microtasks only.
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
