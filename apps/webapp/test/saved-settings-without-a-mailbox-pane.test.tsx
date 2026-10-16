/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import type { ProfileImportTransport } from "../app/shell/ProfileImportCard";

/**
 * A DECLINED SETTINGS DOCUMENT HAS A ROW WHERE THERE IS NO MAILBOX PANE (HOST-CLIENT-DECLINED-
 * SETTINGS-HAS-NO-ROW). The desktop's served client hands the shell no `mailboxSection`, and the
 * declined rows rendered only under one, so "Not now" there left nothing to import or replace from.
 * The shell reads the rows (`useSavedProfiles`) and the pane exists while one stands. Mutation
 * watched red: SettingsView's section gated on `mailboxSection` again.
 */
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as never;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const wrap = (node: React.ReactNode) => h(NextIntlClientProvider, {
  locale: "en", messages, timeZone: "UTC", children: h(ThemeProvider, { children: h(ToastHost, { children: node }) }),
});

describe("the Mailboxes pane on a surface with no mailbox node", () => {
  it("exists, with the declined row, when the shell hands the section in", async () => {
    const { SettingsView } = await import("../app/views/SettingsView");
    await act(async () => {
      root.render(wrap(h(SettingsView, {
        notifications: null, tags: [], tagCounts: {}, initialPane: "mailboxes",
        savedSettingsSection: h("div", { "data-row": "declined" }, "a declined document row"),
      })));
    });
    expect(host.querySelector('[data-row="declined"]'), "the declined row is absent").not.toBeNull();
  });

  it("CONTROL: neither node is no pane at all", async () => {
    const { SettingsView } = await import("../app/views/SettingsView");
    await act(async () => {
      root.render(wrap(h(SettingsView, { notifications: null, tags: [], tagCounts: {}, initialPane: "mailboxes" })));
    });
    expect(host.querySelector('[data-row="declined"]')).toBeNull();
  });
});

describe("the shell's declined rows are the card's own answers", () => {
  const MB = { id: "mbx-1", address: "sam@example.com", status: "connected" };
  const found = {
    fingerprint: "f".repeat(64), updatedAt: "2026-08-10T09:00:00.000Z", producer: { kind: "cloud", version: "1" },
    counts: { screener: 1, rules: 2, notifyRules: 0, tags: 1, awayResponder: false },
  };
  function transport(state: "declined" | "found" | "none"): { via: ProfileImportTransport; asks: () => number } {
    let asks = 0;
    const via = {
      candidate: async () => { asks += 1; return state === "none" ? { state: "none" } : { state, ...found }; },
      apply: async () => ({}), decline: async () => ({}), status: async () => ({}), replace: async () => ({}),
    } as unknown as ProfileImportTransport;
    return { via, asks: () => asks };
  }

  async function mountShellRead(via: ProfileImportTransport) {
    const { useProfileImport } = await import("../app/shell/ProfileImportCard");
    const seen: { declined: number; notNow: (() => void) | null } = { declined: -1, notNow: null };
    function Probe(): null {
      const state = useProfileImport(true, [MB], via);
      seen.declined = state.declined.length;
      seen.notNow = state.offer ? state.notNow : null;
      return null;
    }
    await act(async () => { root.render(wrap(h(Probe))); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return seen;
  }

  it("a declined document is a row, read by the card's one ask", async () => {
    const t = transport("declined");
    const seen = await mountShellRead(t.via);
    expect(seen.declined).toBe(1);
    expect(t.asks(), "the declined rows cost a second request per mailbox").toBe(1);
  });

  it("a Not now adds its row at once, with no ask", async () => {
    const t = transport("found");
    const seen = await mountShellRead(t.via);
    expect(seen.declined).toBe(0);
    await act(async () => { seen.notNow!(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(seen.declined, "the declined document is not a row until something asks again").toBe(1);
    expect(t.asks()).toBe(1);
  });

  it("CONTROL: no declined document is no row, so the host client shows no pane", async () => {
    expect((await mountShellRead(transport("none").via)).declined).toBe(0);
  });
});
