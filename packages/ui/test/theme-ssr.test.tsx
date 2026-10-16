/** @vitest-environment jsdom */
/**
 * ThemeProvider SSR safety: the first client render must be deterministic
 * (no matchMedia / localStorage reads during render) and identical to the
 * server render; the persisted preference and the real OS theme are
 * adopted post-mount; themeInitScript stamps <html> before paint.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { ThemeProvider, themeInitScript, useTheme } from "@ohmail/ui";
import { jarDoor } from "./storage-door.js";

function Probe() {
  const { preference, resolved } = useTheme();
  return (
    <span data-testid="probe">
      {preference}:{resolved}
    </span>
  );
}

function stubMatchMedia(dark: boolean) {
  const mql = {
    matches: dark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mql));
  window.matchMedia = globalThis.matchMedia as typeof window.matchMedia;
  return mql;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // @ts-expect-error test cleanup of the stub
  delete window.matchMedia;
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("ThemeProvider SSR determinism", () => {
  it("server render and first client render agree even when the OS is dark and a preference is stored", () => {
    const app = (
      <ThemeProvider storage={jarDoor()}>
        <Probe />
      </ThemeProvider>
    );
    const ssr = renderToString(app).replace(/<!-- -->/g, "");
    expect(ssr).toContain("system:light");

    // Client: dark OS + persisted dark — the first render must still match SSR.
    stubMatchMedia(true);
    window.localStorage.setItem("ohmail.theme", "dark");

    let firstRenderOutput: string | null = null;
    function FirstRenderSpy() {
      const { preference, resolved } = useTheme();
      if (firstRenderOutput === null) firstRenderOutput = `${preference}:${resolved}`;
      return null;
    }
    render(
      <ThemeProvider storage={jarDoor()}>
        <FirstRenderSpy />
      </ThemeProvider>,
    );
    expect(firstRenderOutput).toBe("system:light");
  });

  it("adopts the persisted preference and the OS theme post-mount", () => {
    stubMatchMedia(true);
    window.localStorage.setItem("ohmail.theme", "dark");
    const { getByTestId } = render(
      <ThemeProvider storage={jarDoor()}>
        <Probe />
      </ThemeProvider>,
    );
    // Effects have flushed: stored preference adopted + stamped.
    expect(getByTestId("probe").textContent).toBe("dark:dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("resolves the OS theme post-mount while in system mode, without stamping", () => {
    stubMatchMedia(true);
    const { getByTestId } = render(
      <ThemeProvider storage={jarDoor()}>
        <Probe />
      </ThemeProvider>,
    );
    expect(getByTestId("probe").textContent).toBe("system:dark");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("does not clobber a pre-paint stamp before adoption completes", () => {
    // Simulate the boot sequence: the inline script stamped dark before React.
    window.localStorage.setItem("ohmail.theme", "dark");
    document.documentElement.dataset.theme = "dark";
    render(
      <ThemeProvider storage={jarDoor()}>
        <Probe />
      </ThemeProvider>,
    );
    // After mount the provider adopted the same stored value — still dark.
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("themeInitScript", () => {
  it("stamps a persisted explicit theme before paint", () => {
    window.localStorage.setItem("ohmail.theme", "dark");
    // eslint-disable-next-line no-eval
    (0, eval)(themeInitScript());
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("leaves the attribute absent for system (and for garbage values)", () => {
    window.localStorage.setItem("ohmail.theme", "system");
    (0, eval)(themeInitScript());
    expect(document.documentElement.dataset.theme).toBeUndefined();

    window.localStorage.setItem("ohmail.theme", "neon");
    (0, eval)(themeInitScript());
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("respects a custom storage key", () => {
    window.localStorage.setItem("acme.theme", "light");
    (0, eval)(themeInitScript("acme.theme"));
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
