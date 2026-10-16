/** @vitest-environment jsdom */
/**
 * ═══ A BUNDLE WITH NO SERVER REACHES THE ERROR BOUNDARY ════════════════════════════════════
 *
 * Two errors mean "this build was never wired to an API", and neither is a statement about
 * anybody's session: `EngineUnarmedError`, and the `ApiError(0, "api_unconfigured")` that the
 * session classifier deliberately rethrows rather than classify. Both files promise these reach
 * an error boundary, because the alternative — rendering the session screen — tells a signed-in
 * person their session expired when the truth is that nobody finished the deploy.
 *
 * ── WHY THE PROMISE WAS NOT KEPT ──────────────────────────────────────────────────────────
 *
 * The confirm's `.catch` did `throw err`, and that `.catch` is attached to a promise nothing
 * awaits. A throw from there is an unhandled rejection, and React error boundaries do not see
 * those: they catch throws from render, from lifecycles and from effect bodies, never from a
 * callback that runs later on the microtask queue. So the deployment-error screen never
 * appeared. What appeared was a tab wedged on the resolving screen — or, worse for the operator
 * of a self-hosted server, an unconfirmed notice offering Try again at a build where trying
 * again cannot ever work.
 *
 * The error is held and re-thrown from the RENDER instead, which is the one place a boundary is
 * watching. What is pinned below: the boundary catches it, the session screens do NOT render,
 * and — the control — an ordinary transient still takes the retry ladder rather than the
 * boundary, so this is not a change that routes every failure to a crash screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as {
  act: (cb: () => Promise<void> | void) => Promise<void>;
}).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ISO = "2026-09-05T12:00:00.000Z";

/** What the boundary caught, if anything. */
let caught: unknown = null;
let roots: Root[] = [];

class Boundary extends React.Component<{ children: React.ReactNode }, { hit: boolean }> {
  state = { hit: false };
  static getDerivedStateFromError(): { hit: boolean } {
    return { hit: true };
  }
  componentDidCatch(err: unknown): void {
    caught = err;
  }
  render(): React.ReactNode {
    return this.state.hit ? h("p", null, "the deployment error screen") : this.props.children;
  }
}

async function mount(resolveOwner: () => Promise<never>): Promise<HTMLElement> {
  const { EngineProvider } = await import("../app/shell/engine.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date(ISO),
      children: h(Boundary, {
        children: h(EngineProvider, {
          demo: false,
          resolveOwner: resolveOwner as never,
          children: h("div", { className: "app-root" }, "mailbox"),
        }),
      }),
    }));
  });
  return container;
}

async function tick(ms: number): Promise<void> {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  };
  await act(flush);
  for (let left = ms; left > 0; left -= 250) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(250, left));
      await flush();
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(ISO));
  caught = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount());
  roots = [];
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a confirm that cannot possibly succeed", () => {
  it("api_unconfigured reaches the error boundary, not the session screen", async () => {
    const { ApiError } = await import("../app/api-client.js");
    const el = await mount(async () => {
      throw new ApiError(0, "api_unconfigured", "no API base is configured for this build");
    });
    await tick(2_000);

    expect(caught, "the deployment error never reached a boundary").toBeInstanceOf(ApiError);
    expect((caught as InstanceType<typeof ApiError>).code).toBe("api_unconfigured");
    expect(el.textContent, "the deployment error screen did not render")
      .toContain("the deployment error screen");
    // And NOT dressed as an auth outcome: no signed-out pane, and no offer to try again at a
    // build where trying again can never work.
    expect(el.textContent).not.toContain("You are signed out");
    expect(el.textContent).not.toContain("Try again");
  });

  it("EngineUnarmedError reaches it too", async () => {
    // From the shell's own module, which is where it is declared and thrown.
    const { EngineUnarmedError } = await import("../app/shell/engine-config.js");
    const el = await mount(async () => { throw new EngineUnarmedError(); });
    await tick(2_000);
    expect(caught, "an unarmed engine never reached a boundary")
      .toBeInstanceOf(EngineUnarmedError);
    expect(el.textContent).toContain("the deployment error screen");
  });

  /**
   * THE CONTROL, and it is the half that keeps the two fixes apart. A transient must still take
   * the retry ladder: routing every rejection to a crash screen would undo the whole slice,
   * which exists because a failure to ANSWER was being read as an answer.
   */
  it("an ordinary transient does NOT reach the boundary", async () => {
    const el = await mount(async () => { throw new TypeError("network down"); });
    await tick(60_000);
    expect(caught, "a dropped connection crashed the tab").toBeNull();
    expect(el.textContent, "the deployment screen rendered for a network failure")
      .not.toContain("the deployment error screen");
  });
});
