/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { makeHydrateBody } from "../app/shell/AppShell";

/**
 * SCREENER-HYDRATE — the body-hydration callback must FORWARD the caller's `{ retry }` option.
 *
 * `AppShell` builds one `hydrateBody` and hands it to every pile. It used to be
 * `(messageId) => engine.hydrateBody(messageId)`, dropping the second argument. Every consumer's
 * type is `(id, opts?: { retry?: boolean }) => void`, and four of them — `MessagePane`,
 * `ScreenerView`, `ReadsView`, `ReceiptsView` — pass `{ retry: true }` when a human presses "try
 * again". `OhmailEngine.hydrateBody` re-asks a FAILED body only under that flag, so with it
 * dropped every retry button was inert: a held message whose body 500'd could not be recovered
 * short of reloading the tab, and in the Screener that is a consent decision left standing on a
 * one-line snippet. The declared type accepted `opts` and the closure ignored them — nothing could
 * see the difference until it was a named unit.
 *
 * A spy engine, so this asserts the FORWARD and not the engine's own retry logic (which
 * `packages/client-engine/test/body-hydration.test.ts` already owns).
 */
describe("makeHydrateBody", () => {
  const record = (): {
    calls: Array<[string, { retry?: boolean } | undefined]>;
    engine: { hydrateBody: (id: string, opts?: { retry?: boolean }) => void };
  } => {
    const calls: Array<[string, { retry?: boolean } | undefined]> = [];
    return {
      calls,
      engine: { hydrateBody: (id, opts) => { calls.push([id, opts]); } },
    };
  };

  it("forwards { retry: true } to the engine — the human 'try again' path", () => {
    const { calls, engine } = record();
    makeHydrateBody(engine)("m-1", { retry: true });
    expect(calls).toEqual([["m-1", { retry: true }]]);
  });

  it("passes no options on the automatic trigger, so a refused body is not re-polled", () => {
    const { calls, engine } = record();
    makeHydrateBody(engine)("m-2");
    expect(calls).toEqual([["m-2", undefined]]);
  });
});
