/** @vitest-environment jsdom */
/**
 * THE RAIL'S SCHEME CONTROL, as the shipped shell renders it.
 *
 * One glyph carries light, dark and auto, so the control's whole legibility is its NAME and its
 * GLYPH: the name states the state and what the press will do, the live region says the new
 * state after a press and nothing at mount, and the glyph is picked by a lookup table so the
 * three states cannot silently share a picture. Both locales, because the sentence is
 * assembled from four catalogue entries and an assembly is exactly what survives a translator
 * and breaks a template.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISO,
  act,
  installShellEnv,
  mailbox,
  mountShell,
  teardownShellEnv,
  tick,
} from "./fixtures/live-walk-shell";

/**
 * The shipped shell, settled. `mountShell` returns as soon as its first frame lands, and on a
 * WARM module graph (every mount after the first in one file) that is before the session gate
 * has answered — the rail is not in the DOM yet. Ticking until the dock exists is the honest
 * wait; a fixed sleep would be a race written down.
 */
async function mountWithRail(opts: Parameters<typeof mountShell>[1] = {}): Promise<HTMLElement> {
  const c = await mountShell([mailbox({ lastSyncAt: ISO })], opts);
  for (let i = 0; i < 20 && c.querySelector("nav.rail .rail-dock .dock-theme") === null; i++) {
    await tick(10);
  }
  expect(c.querySelector("nav.rail .rail-dock .dock-theme"), "the rail never mounted").not.toBeNull();
  return c;
}

const dock = (c: HTMLElement) => c.querySelector<HTMLButtonElement>("nav.rail .rail-dock .dock-theme")!;
const said = (c: HTMLElement) => c.querySelector<HTMLElement>("nav.rail .rail-dock .sync-say")!;
/** The glyph, by the one thing that tells the three apart in a DOM with no CSS: its path data. */
const glyphOf = (c: HTMLElement): "sun" | "moon" | "auto" | "unknown" => {
  const svg = dock(c).querySelector("svg.ic")!;
  if (svg.querySelector('path[fill="currentColor"]')) return "auto";
  if (svg.querySelector("circle")) return "sun";
  if (svg.querySelector("path")) return "moon";
  return "unknown";
};

/** A dark system, the arm the reported defect was seen on. */
function darkSystem(): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("dark"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  installShellEnv();
  darkSystem();
});
/* AWAITED. `teardownShellEnv` is async and restores real timers; an un-awaited call resolves
   inside the NEXT test and takes the fake clock out from under it mid-mount. */
afterEach(async () => {
  await teardownShellEnv();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("the scheme control names its state and its next step", () => {
  it("on a dark system it opens on Auto (dark) and says the press is Light", async () => {
    const c = await mountWithRail();
    expect(dock(c).getAttribute("aria-label")).toBe("Theme: Auto (dark). Press for Light");
    expect(dock(c).getAttribute("title")).toBe("Theme: Auto (dark). Press for Light");
    expect(glyphOf(c)).toBe("auto");
    /* Nothing is announced at boot — the region is empty until somebody presses. */
    expect(said(c).textContent).toBe("");
  });

  it("three presses walk sun, moon, auto and the live region says each new state", async () => {
    const c = await mountWithRail();
    await act(async () => dock(c).click());
    expect(glyphOf(c)).toBe("sun");
    expect(said(c).textContent).toBe("Theme: Light");
    expect(dock(c).getAttribute("aria-label")).toBe("Theme: Light. Press for Dark");

    await act(async () => dock(c).click());
    expect(glyphOf(c)).toBe("moon");
    expect(said(c).textContent).toBe("Theme: Dark");
    /* Dark IS what the system says, so the next press is the hand-back to auto. */
    expect(dock(c).getAttribute("aria-label")).toBe("Theme: Dark. Press for Auto (dark)");

    await act(async () => dock(c).click());
    expect(glyphOf(c)).toBe("auto");
    expect(said(c).textContent).toBe("Theme: Auto (dark)");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("the live region is a polite status, not a label", async () => {
    const c = await mountWithRail();
    expect(said(c).getAttribute("role")).toBe("status");
    expect(said(c).getAttribute("aria-live")).toBe("polite");
  });

  it("a German window says the same thing in German", async () => {
    const c = await mountWithRail({ locale: "de" });
    expect(dock(c).getAttribute("aria-label")).toBe(
      "Erscheinungsbild: Automatisch (dunkel). Drücken für Hell",
    );
    await act(async () => dock(c).click());
    expect(said(c).textContent).toBe("Erscheinungsbild: Hell");
    expect(dock(c).getAttribute("aria-label")).toBe(
      "Erscheinungsbild: Hell. Drücken für Dunkel",
    );
  });

  /**
   * THE WORD IS THE SAME EVERYWHERE, AND THE OLD ONES ARE GONE. A rename that leaves the old key
   * behind is a second copy of a decision, and the half nobody edits is the half a reader meets.
   */
  it("both catalogues carry the new keys and neither carries the old ones", () => {
    for (const locale of ["en", "de"]) {
      const c = JSON.parse(
        readFileSync(resolve(process.cwd(), `apps/webapp/messages/${locale}.json`), "utf8"),
      ) as Record<string, Record<string, unknown>>;
      for (const key of ["theme", "themeNow", "themeLight", "themeDark", "themeAuto", "schemeLight", "schemeDark"]) {
        expect(c.dock[key], `${locale} dock.${key}`).toBeTypeOf("string");
      }
      for (const key of ["themeLight", "themeDark", "themeAuto"]) {
        expect(c.palette[key], `${locale} palette.${key}`).toBeTypeOf("string");
      }
      expect(c.settings.themeAuto, `${locale} settings.themeAuto`).toBeTypeOf("string");
      /* The three the rename replaced. `dock.theme` survives as a KEY and must no longer hold
         the old two-state sentence, which is why it is checked by value. */
      expect(c.palette.toggleTheme, `${locale} palette.toggleTheme survived`).toBeUndefined();
      expect(c.settings.themeSystem, `${locale} settings.themeSystem survived`).toBeUndefined();
      expect(String(c.dock.theme)).toContain("{state}");
    }
  });
});
