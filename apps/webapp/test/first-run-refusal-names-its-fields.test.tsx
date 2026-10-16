/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import type { FirstRunHost } from "../app/shell/first-run-host";
import type { OnboardingFacts } from "../app/shell/onboarding";

/**
 * THE FIRST-RUN TEST VERDICT NAMES ONLY THE FIELDS ON SCREEN. Behind a named provider the stage
 * shows no host and no port, and a refused test said "Check the IMAP host and port" anyway. The
 * generic entry has both fields, so there it keeps the sentence that names them — the control.
 */

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
});

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const copy = messages.mailboxes as unknown as Record<string, string>;

const facts: OnboardingFacts = {
  door: "local", mailbox: null, account: { onboardingCompletedAt: null }, ai: "unset", queuedSenders: 0,
};

async function mount(reason: string): Promise<{ el: HTMLElement; press: (label: string) => Promise<void> }> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  const host: FirstRunHost = {
    door: "local",
    ai: "unset",
    probe: async () => { throw new Error("refused"); },
    connect: async () => ({ id: "mb-1" }),
    organize: async () => "stored",
    complete: async () => { /* nothing to finish here */ },
    setAiEnabled: async () => { /* answered */ },
    probeReason: () => reason,
    probeMessage: () => "the server's own sentence",
  };
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, {
        children: h(FirstRun, {
          host, facts, onRefresh: () => {}, onLeave: () => {},
          pull: { screened: 0, history: 0, pulled: 0 }, decide: null, mailboxId: null,
        }),
      }),
    }));
  });
  const press = async (label: string): Promise<void> => {
    const button = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
    expect(button, `no button labelled ${label}`).toBeTruthy();
    await act(async () => { button!.click(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
  };
  await press("Set up a mailbox");
  return { el, press };
}

const verdict = (el: HTMLElement): string => el.querySelector(".set-verdict.bad")?.textContent ?? "";

describe("the first-run test verdict", () => {
  for (const reason of ["connect", "timeout", "tls"]) {
    it(`behind a named provider, ${reason} names no host and no port`, async () => {
      const { el, press } = await mount(reason);
      expect(el.querySelector('input[type="radio"][value="gmail"]:checked'), "the stage opens on a named provider").toBeTruthy();
      await press("Test connection");
      expect(verdict(el)).not.toBe("");
      expect(verdict(el)).not.toMatch(/\bport\b|\bhost\b|server name/i);
    });
  }

  it("on the generic entry, which has both fields, the sentence names them", async () => {
    const { el, press } = await mount("connect");
    const generic = el.querySelector<HTMLInputElement>('input[type="radio"][value="imap"]');
    expect(generic).toBeTruthy();
    await act(async () => { generic!.click(); });
    expect(el.querySelector("[id$='-imap-port']"), "the generic entry shows a port field").toBeTruthy();
    await press("Test connection");
    expect(verdict(el)).toContain(copy.probe_connect!);
  });
});
