/** @vitest-environment jsdom */
/**
 * THE SCHEME CONTROL'S CYCLE, and what "the system" is.
 *
 * One glyph carries three states, so the rule that decides the next one is the whole control.
 * A fixed ring light → dark → auto was rejected because on a light system the first press out
 * of auto changes nothing on the canvas — which is the defect this lane exists to fix — so the
 * rule is resolved-aware: out of auto goes to the OPPOSITE of what is rendered, and the
 * hand-back to auto is the one press that leaves the canvas alone.
 *
 * "The system" is the host's `SystemSchemeSource` where it wired one — on Omarchy the active
 * desktop theme's mode, which `prefers-color-scheme` learns only through the GTK portal — and
 * the media query everywhere else. The source is read at PRESS time, so a desktop theme that
 * changed between two presses is obeyed rather than remembered.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  ThemeProvider,
  nextSchemePreference,
  useTheme,
  type ResolvedTheme,
  type SystemSchemeSource,
  type ThemePreference,
} from "@ohmail/ui";
import { jarDoor } from "./storage-door.js";

let press: () => void = () => {};
let seen: { preference: ThemePreference; resolved: ResolvedTheme; next: ThemePreference } = {
  preference: "system",
  resolved: "light",
  next: "dark",
};

function Probe() {
  const theme = useTheme();
  press = theme.cycle;
  seen = { preference: theme.preference, resolved: theme.resolved, next: theme.next };
  return null;
}

function stubMatchMedia(dark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: dark,
      media: "(prefers-color-scheme: dark)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  window.matchMedia = globalThis.matchMedia as typeof window.matchMedia;
}

/** A host source that can be flipped and notifies, like the Omarchy feed's. */
function fakeSource(initial: ResolvedTheme | null) {
  let value = initial;
  const watchers = new Set<() => void>();
  return {
    source: {
      get: () => value,
      subscribe: (cb: () => void) => {
        watchers.add(cb);
        return () => watchers.delete(cb);
      },
    } satisfies SystemSchemeSource,
    set(next: ResolvedTheme | null) {
      value = next;
      for (const cb of watchers) cb();
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // @ts-expect-error test cleanup of the stub
  delete window.matchMedia;
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("the cycle rule, as a pure function", () => {
  it("out of auto goes to the opposite of what is rendered, and home again in three", () => {
    /* Source dark. Every press below changes something a person can see except the last, and
       the last is the hand-back the auto glyph exists to make legible. */
    expect(nextSchemePreference("system", "dark")).toBe("light");
    expect(nextSchemePreference("light", "dark")).toBe("dark");
    expect(nextSchemePreference("dark", "dark")).toBe("system");
    /* Source light — the arm a fixed ring gets wrong. */
    expect(nextSchemePreference("system", "light")).toBe("dark");
    expect(nextSchemePreference("dark", "light")).toBe("light");
    expect(nextSchemePreference("light", "light")).toBe("system");
  });
});

describe("the cycle, through the provider", () => {
  it("on a dark system: auto → light → dark → auto, and the first press is visible", async () => {
    stubMatchMedia(true);
    render(
      <ThemeProvider storage={jarDoor()}>
        <Probe />
      </ThemeProvider>,
    );
    await act(async () => {});
    expect(seen.preference).toBe("system");
    expect(seen.resolved).toBe("dark");

    await act(async () => press());
    expect(seen.preference).toBe("light");
    /* THE POINT: the press out of auto changed what is rendered, not only the attribute. */
    expect(seen.resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    await act(async () => press());
    expect(seen.preference).toBe("dark");
    await act(async () => press());
    expect(seen.preference).toBe("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("on a light system: auto → dark → light → auto", async () => {
    stubMatchMedia(false);
    render(
      <ThemeProvider storage={jarDoor()}>
        <Probe />
      </ThemeProvider>,
    );
    await act(async () => {});
    expect(seen.resolved).toBe("light");
    await act(async () => press());
    expect(seen.preference).toBe("dark");
    expect(seen.resolved).toBe("dark");
    await act(async () => press());
    expect(seen.preference).toBe("light");
    await act(async () => press());
    expect(seen.preference).toBe("system");
  });

  it("a source that changes between presses is read at press time, not remembered", async () => {
    stubMatchMedia(false);
    const { source, set } = fakeSource("dark");
    render(
      <ThemeProvider storage={jarDoor()} systemScheme={source}>
        <Probe />
      </ThemeProvider>,
    );
    await act(async () => {});
    /* The host's source outranks the media query: matchMedia says light, the desktop says dark. */
    expect(seen.resolved).toBe("dark");
    await act(async () => press());
    expect(seen.preference).toBe("light");

    /* `omarchy theme set` to a light theme between two presses. From light, with the system now
       light, the next press is the hand-back — not "the other explicit scheme". */
    await act(async () => set("light"));
    expect(seen.next).toBe("system");
    await act(async () => press());
    expect(seen.preference).toBe("system");
  });
});

describe("auto follows the feed", () => {
  it("the source flips and notifies: resolved flips, the attribute stays absent", async () => {
    stubMatchMedia(false);
    const { source, set } = fakeSource("dark");
    render(
      <ThemeProvider storage={jarDoor()} systemScheme={source}>
        <Probe />
      </ThemeProvider>,
    );
    await act(async () => {});
    expect(seen.preference).toBe("system");
    expect(seen.resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();

    await act(async () => set("light"));
    expect(seen.resolved).toBe("light");
    /* Auto is the ABSENT attribute — the paint comes from the face's no-explicit-theme rule,
       and a provider that stamped one here would be answering for the feed. */
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("no source, or a source that cannot say: the media query answers, exactly as before", async () => {
    stubMatchMedia(true);
    const { source } = fakeSource(null);
    render(
      <ThemeProvider storage={jarDoor()} systemScheme={source}>
        <Probe />
      </ThemeProvider>,
    );
    await act(async () => {});
    expect(seen.resolved).toBe("dark");
    expect(seen.next).toBe("light");
  });
});
