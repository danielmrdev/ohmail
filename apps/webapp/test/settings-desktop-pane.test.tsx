/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

import { SettingsView } from "../app/views/SettingsView";

/**
 * THE DESKTOP'S SETTINGS PANE IS ABSENT ON THE WEB, STRUCTURALLY.
 *
 * `SettingsView` is one file compiled into two products: a browser tab, and the desktop app that
 * has a native shell behind it. That pane's every control is a call to the shell — sign out,
 * switch door, sign in again — so the shared view takes a NODE and the desktop supplies one. The
 * consequence worth a test is the one a boolean would not have given: on the web there is no
 * pane because there is nothing to render, not because a flag is false.
 *
 * ── WHY THIS IS NOT COVERED BY THE FOUR PANES BESIDE IT ─────────────────────────────────────
 *
 * Account, Security, Subscription and Mailboxes are all withheld on `?demo=1` by the shell, which
 * passes `demo ? undefined : …`. The desktop pane is deliberately NOT gated that way, because the
 * desktop shell runs this client in demo mode — gating it the same way would remove the pane from
 * the one surface it exists for. That exception is exactly the kind of thing that silently starts
 * leaking a pane onto the web, so both directions are asserted here.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

let host: HTMLDivElement;
let root: Root;

async function mount(props: Parameters<typeof SettingsView>[0]) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, h(SettingsView, props))),
      }),
    );
  });
}

const BASE: Parameters<typeof SettingsView>[0] = {
  notifications: null,
  tags: [],
  tagCounts: {},
};

const navLabels = () =>
  [...host.querySelectorAll(".set-nav button")].map((b) => b.textContent?.trim());

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

describe("Settings → the desktop pane", () => {
  it("offers no such pane to a browser tab", async () => {
    await mount({ ...BASE });
    expect(navLabels()).not.toContain("This install");
    // …and not merely hidden behind a nav entry nobody clicks: the words are nowhere.
    expect(host.textContent).not.toMatch(/On this Mac|Switch…/);
  });

  it("offers it — under the label the shell supplied — when a shell hands one in", async () => {
    await mount({
      ...BASE,
      desktopSection: {
        label: "This install",
        node: h("p", { className: "probe" }, "Connected through On this Mac"),
      },
    });
    expect(navLabels()).toContain("This install");

    // It is not the pane on screen until it is chosen — General still is.
    expect(host.querySelector(".probe")).toBeNull();
    const entry = [...host.querySelectorAll(".set-nav button")].find(
      (b) => b.textContent?.trim() === "This install",
    )!;
    await act(async () => {
      entry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.querySelector(".probe")?.textContent).toBe("Connected through On this Mac");
  });

  /**
   * IT OPENS THE ACCOUNT-ADMINISTRATION GROUP.
   *
   * On the desktop this IS the account: there is no Subscription, no Security and no Account
   * pane, and the door, the mailbox and the sign-out live here instead. Its position is therefore
   * a claim about what it is, not a layout preference — after the panes that organise mail, before
   * the three that need a server.
   */
  it("sits after the mail panes and before the ones that need a server", async () => {
    await mount({
      ...BASE,
      desktopSection: { label: "This install", node: h("p", null, "x") },
      billingSection: h("p", null, "billing"),
      securitySection: h("p", null, "security"),
      accountSection: h("p", null, "account"),
      aboutSection: h("p", null, "about"),
    });
    const labels = navLabels();
    expect(labels.indexOf("This install")).toBeGreaterThan(labels.indexOf("Tags"));
    expect(labels.indexOf("This install")).toBeLessThan(labels.indexOf("Subscription"));
    expect(labels.indexOf("This install")).toBeLessThan(labels.indexOf("Account"));
  });
});
