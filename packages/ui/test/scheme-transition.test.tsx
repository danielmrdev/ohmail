/** @vitest-environment jsdom */
/**
 * THE SCHEME CROSSFADE — when it runs, when it refuses, and what it does without the API.
 *
 * Three refusals, and each is a defect if it fails: the window must not fade into existence at
 * boot (the stamps before first paint are instant), a person who asked for reduced motion gets
 * an immediate change and no class, and a webview without `startViewTransition` — which is not
 * a hypothetical across WebKitGTK, WKWebView and WebView2 — still gets a fade rather than
 * nothing, through a class that is re-armed on a second change instead of stacking.
 *
 * The one thing no test here can see is the PAINT: jsdom runs no animations. What it can see is
 * that the right mechanism was reached and that the change itself always lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  ThemeProvider,
  armSchemeTransitions,
  resetSchemeTransitionsForTests,
  setViewTransitions,
  useTheme,
  withSchemeTransition,
} from "@ohmail/ui";
import { jarDoor } from "./storage-door.js";

let press: () => void = () => {};
function Probe() {
  press = useTheme().cycle;
  return null;
}

const shifting = () => document.documentElement.classList.contains("scheme-shift");

/** A document with the API, counting its calls and running the callback like the real one. */
function withViewTransitions() {
  const spy = vi.fn((cb: () => void) => {
    cb();
    return { finished: Promise.resolve(), ready: Promise.resolve() };
  });
  (document as unknown as Record<string, unknown>).startViewTransition = spy;
  return spy;
}

function stubMatchMedia(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("reduced-motion") ? reduced : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  window.matchMedia = globalThis.matchMedia as typeof window.matchMedia;
}

/** Past the arming frame — the provider arms on `requestAnimationFrame`. */
async function pastFirstPaint(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.resolve();
  });
}

beforeEach(() => {
  resetSchemeTransitionsForTests();
  stubMatchMedia(false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as unknown as Record<string, unknown>).startViewTransition;
  // @ts-expect-error test cleanup of the stub
  delete window.matchMedia;
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  resetSchemeTransitionsForTests();
});

describe("armed after first paint, and not before", () => {
  it("the adoption stamp does not fade; a press after the arming frame does", async () => {
    const spy = withViewTransitions();
    render(
      <ThemeProvider storage={jarDoor()}>
        <Probe />
      </ThemeProvider>,
    );
    await act(async () => {});
    /* The window has just appeared. The boot stamp re-writes what the pre-paint script already
       put on <html>, and fading that is the window animating into existence. */
    expect(spy).toHaveBeenCalledTimes(0);

    await pastFirstPaint();
    await act(async () => press());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("reduced motion", () => {
  it("changes instantly — no transition, no class, and the change still lands", async () => {
    stubMatchMedia(true);
    const spy = withViewTransitions();
    render(
      <ThemeProvider storage={jarDoor()}>
        <Probe />
      </ThemeProvider>,
    );
    await pastFirstPaint();
    await act(async () => press());
    expect(spy).toHaveBeenCalledTimes(0);
    expect(shifting()).toBe(false);
    /* The refusal is about the ANIMATION only. A scheme control that stopped working under
       reduced motion would be the worse defect. */
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("no view transitions — the class fallback", () => {
  it("is instant while unarmed, wears `scheme-shift` once armed, and drops it after 320ms", () => {
    vi.useFakeTimers();
    let ran = 0;

    withSchemeTransition(() => {
      ran += 1;
    });
    expect(ran, "an unarmed change still applies").toBe(1);
    expect(shifting(), "unarmed must be instant").toBe(false);

    armSchemeTransitions();
    withSchemeTransition(() => {
      ran += 1;
      /* The class is on for the change itself — a class added after it would transition
         nothing, because the new values are already computed. */
      expect(shifting()).toBe(true);
    });
    expect(ran).toBe(2);
    vi.advanceTimersByTime(319);
    expect(shifting()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(shifting()).toBe(false);
  });

  it("a second change re-arms the class rather than stacking a second timer", () => {
    vi.useFakeTimers();
    armSchemeTransitions();
    withSchemeTransition(() => {});
    vi.advanceTimersByTime(200);
    /* A press during the fade. The first timer must not take the class off mid-second-change. */
    withSchemeTransition(() => {});
    vi.advanceTimersByTime(200);
    expect(shifting(), "the first timer stripped the class under a live second change").toBe(true);
    vi.advanceTimersByTime(120);
    expect(shifting()).toBe(false);
  });
});

/* A host's veto (issue #9): WebKitGTK without a GPU backing store dies on a view transition. */
describe("a host that turns view transitions off", () => {
  it("never reaches startViewTransition, fades by class, and the change still lands", () => {
    vi.useFakeTimers();
    const spy = withViewTransitions();
    armSchemeTransitions();
    setViewTransitions(false);
    let ran = 0;
    for (let i = 0; i < 3; i += 1) {
      withSchemeTransition(() => {
        ran += 1;
        expect(shifting(), "the class fallback did not take over").toBe(true);
      });
    }
    expect(spy, "startViewTransition was called with the switch off").toHaveBeenCalledTimes(0);
    expect(ran).toBe(3);
  });

  it("control: the same document with the switch on does reach the API", () => {
    const spy = withViewTransitions();
    armSchemeTransitions();
    setViewTransitions(false);
    setViewTransitions(true);
    withSchemeTransition(() => {});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(shifting()).toBe(false);
  });
});
