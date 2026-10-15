/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * SETTINGS SECTIONS ARE PLACES — `#/settings/<pane>` resolves, deep-links and walks with
 * Back/Forward.
 *
 * `#/settings` used to be the deepest thing the URL could say: which section was open lived in
 * view-local state, so a link could not name one, a reload forgot one, and Back left Settings
 * instead of leaving the section. The router now carries the pane the way it carries a screener
 * segment or a triage pile:
 *
 *   · `#/settings/devices` loads DIRECTLY onto Devices;
 *   · selecting a section WRITES the hash (`goSettings`, always the named form), so each
 *     section lands in history and Back/Forward walk them;
 *   · the BARE `#/settings` stays a real spelling — `settingsPane: null` — reserved for the
 *     view's own deep-link logic (`?settings=<pane>`, the consent ceremony's return), which an
 *     explicit segment outranks;
 *   · an unknown sub-path falls back to bare, and `normalizedHash` rewrites the bar to match —
 *     the same posture as `#/screener/bogus` and `#/triage/bogus`.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { canonicalHash, goSettings, normalizedHash, parseHash } from "../app/shell/routing";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove(); root = null; host = null;
  window.location.hash = "";
  vi.restoreAllMocks();
});

describe("the route carries the settings pane", () => {
  it("parses, canonicalizes and normalizes the settings segment like every other segment", () => {
    expect(parseHash("#/settings/devices")).toMatchObject({ view: "settings", settingsPane: "devices" });
    expect(parseHash("#/settings/general")).toMatchObject({ view: "settings", settingsPane: "general" });
    // BARE is a real spelling, not a default pane: null keeps the view's deep-link logic in charge.
    expect(parseHash("#/settings")).toMatchObject({ view: "settings", settingsPane: null });
    // An unknown sub-path falls back to bare rather than 404ing…
    expect(parseHash("#/settings/bogus")).toMatchObject({ view: "settings", settingsPane: null });
    // …and the bar is rewritten to the spelling that reproduces what is on screen.
    expect(normalizedHash("#/settings/bogus")).toBe("#/settings");
    expect(normalizedHash("#/settings/devices")).toBeNull();
    expect(normalizedHash("#/settings")).toBeNull();
    // Round trips, both spellings.
    expect(canonicalHash(parseHash("#/settings/devices"))).toBe("#/settings/devices");
    expect(canonicalHash(parseHash("#/settings"))).toBe("#/settings");
  });

  it("goSettings always writes the NAMED form — a click is a decision, and bare would hand it back", () => {
    goSettings("devices");
    expect(window.location.hash).toBe("#/settings/devices");
    goSettings("general");
    expect(window.location.hash).toBe("#/settings/general");
  });
});

/** The shell's wiring shape: the route controls the pane, a nav click writes the hash. */
function Routed(): React.ReactElement {
  // Deferred import binding — the module is loaded by mount() below before first render.
  const { useHashRoute } = routing!;
  const { SettingsView } = settings!;
  const route = useHashRoute();
  return h(SettingsView as never, {
    notifications: null, tags: [], tagCounts: {},
    devicesSection: h("p", { className: "devices-probe" }, "the pane"),
    pane: route.settingsPane ?? undefined,
    onSelectPane: goSettings,
  } as never);
}
let routing: typeof import("../app/shell/routing") | null = null;
let settings: typeof import("../app/views/SettingsView") | null = null;

async function mount(): Promise<HTMLElement> {
  routing = await import("../app/shell/routing.js");
  settings = await import("../app/views/SettingsView.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, h(Routed))),
      }),
    );
  });
  return host!;
}

/**
 * A hash move, the way navigation and the Back button both reach the page: the fragment changes
 * and `hashchange` fires. Dispatched explicitly because jsdom queues its own event with timing
 * the test should not depend on; the DUPLICATE dispatch is harmless (`useSyncExternalStore`
 * re-reads the same snapshot).
 */
async function goHash(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

const activeNav = (c: ParentNode): string =>
  [...c.querySelectorAll(".set-nav button")].find((b) => b.className === "on")?.textContent?.trim() ?? "";

describe("the view follows the route, and clicks write it", () => {
  it("direct-loading #/settings/devices lands ON Devices — no clicking around", async () => {
    window.location.hash = "#/settings/devices";
    const c = await mount();
    expect(c.querySelector(".devices-probe"), "the devices pane, straight from the URL").toBeTruthy();
    expect(activeNav(c)).toBe("Devices");
  });

  it("clicking a section writes the hash; a hash move (Back) brings the section back", async () => {
    window.location.hash = "#/settings/devices";
    const c = await mount();

    const tags = [...c.querySelectorAll(".set-nav button")].find((b) => b.textContent?.trim() === "Tags")!;
    await act(async () => { (tags as HTMLElement).click(); });
    // The click wrote the ROUTE — one source — and the route came back down as the pane.
    expect(window.location.hash).toBe("#/settings/tags");
    await goHash("#/settings/tags"); // flush the route store past jsdom's own event timing
    expect(activeNav(c)).toBe("Tags");
    expect(c.querySelector(".devices-probe")).toBeNull();

    // Back is a hash move to the previous entry; the section follows it.
    await goHash("#/settings/devices");
    expect(activeNav(c)).toBe("Devices");
    expect(c.querySelector(".devices-probe")).toBeTruthy();
  });

  it("the bare hash leaves the ?settings= deep link in charge — the ceremony's return still lands", async () => {
    window.history.replaceState(null, "", "/?settings=tags#/settings");
    const c = await mount();
    expect(activeNav(c)).toBe("Tags");
    // …but an explicit segment outranks the query: the person's click is the later word.
    await goHash("#/settings/general");
    expect(activeNav(c)).toBe("General");
  });
});
