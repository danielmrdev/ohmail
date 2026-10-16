/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { SettingsView, initialPaneFromUrl } from "../app/views/SettingsView";

/**
 * WHICH SETTINGS PANE A LINK LANDS ON.
 *
 * The Screener's AI-credit line offers "start a plan", and the offer is a promise about a
 * specific pane: the one with the plan cards on it. Landing on General instead is the shape of
 * broken promise nobody files a bug about — they just do not find the thing and stop looking.
 *
 * Two things are checked, and the second is the one a plausible implementation gets wrong:
 *
 *  1. a caller that names a pane opens on it;
 *  2. naming a pane does not PIN it. The prop is read once, as initial state, exactly as the
 *     `?settings=` deep link is — so the nav still works afterwards. A watched prop would drag
 *     the person back to Subscription every time they clicked away.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

async function render(initialPane?: "billing" | "general"): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T12:00:00.000Z"),
    children: h(ThemeProvider as never, {
      children: h(ToastHost as never, {
        children: h(SettingsView as never, {
          notifications: null,
          tags: [],
          tagCounts: {},
          // The Subscription pane is INJECTED by the Cloud client — the shared view only offers a
          // nav entry when a node is supplied, so a sentinel node is what makes the pane exist.
          billingSection: h("div", null, "SUBSCRIPTION PANE"),
          initialPane,
        } as never),
      } as never),
    } as never),
  });
  await act(async () => { root!.render(el); });
  return host;
}

describe("SettingsView's initial pane", () => {
  it("opens on GENERAL when nobody says otherwise", async () => {
    const el = await render();
    expect(el.textContent).not.toContain("SUBSCRIPTION PANE");
  });

  it("opens on the pane the CALLER named — the Screener's offer keeps its promise", async () => {
    const el = await render("billing");
    expect(el.textContent).toContain("SUBSCRIPTION PANE");
  });

  it("does not PIN it — the nav still moves off the named pane", async () => {
    const el = await render("billing");
    expect(el.textContent).toContain("SUBSCRIPTION PANE");
    // Click the General entry. Read off the rendered nav rather than a test id: the label is the
    // thing a person clicks, and a nav that stopped rendering it would fail here rather than pass
    // against a hook nobody can see.
    const general = [...el.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === messages.settings.general);
    expect(general, "the General nav entry is not rendered").toBeTruthy();
    await act(async () => { general!.click(); });
    expect(el.textContent).not.toContain("SUBSCRIPTION PANE");
  });

  it("the URL deep link is unchanged and still answers `general` for anything unknown", () => {
    // The prop is a SECOND way to ask the same question, not a replacement: the Microsoft consent
    // return still comes back through `?settings=mailboxes`.
    expect(initialPaneFromUrl()).toBe("general");
  });
});
