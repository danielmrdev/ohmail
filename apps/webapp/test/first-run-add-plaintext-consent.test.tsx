/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import type { FirstRunHost, FirstRunMailboxInput } from "../app/shell/first-run-host";
import type { OnboardingFacts } from "../app/shell/onboarding";

/**
 * THE ADD-A-MAILBOX RUN CAN CONNECT A HOME MAIL SERVER WITHOUT TLS. Setup's mailbox step and
 * Settings → Mailboxes offer a consent line per protocol after the server refuses that protocol
 * as having no TLS on a private network; `#/first-run/add` sent no consent at all, so the same
 * server connected from two doors and not from this one. The doubles answer as the doors do: a
 * Test refuses the incoming half by throwing, the outgoing half's refusal arrives on Connect.
 */

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
});

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const copy = messages.mailboxes;
const IMAP_LINE = copy.insecureConsentLabel;
const SMTP_LINE = copy.insecureConsentLabelSmtp;

const facts: OnboardingFacts = {
  door: "cloud", mailbox: null, account: { onboardingCompletedAt: "2026-03-01T11:30:00.000Z" }, ai: "on", queuedSenders: 0,
};

/** A refusal the host reads: `offer` names the protocol the server offered plaintext for. */
class NoTls extends Error { constructor(readonly offer: "imap" | "smtp" | null) { super("no encryption"); } }

async function mount(refusals: Array<"imap" | "smtp" | null>, connectRefusals: Array<"imap" | "smtp"> = []) {
  const probed: FirstRunMailboxInput[] = [];
  const connected: FirstRunMailboxInput[] = [];
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  const host: FirstRunHost = {
    door: "cloud",
    ai: "on",
    probe: async (input) => {
      probed.push(input);
      const next = refusals.shift();
      if (next !== undefined) throw new NoTls(next);
      return { host: input.imap.host, user: input.address, folders: 1 };
    },
    connect: async (input) => {
      connected.push(input);
      const next = connectRefusals.shift();
      if (next !== undefined) throw new NoTls(next);
      return { id: "mb-2" };
    },
    organize: async () => "stored",
    complete: async () => { /* nothing to finish here */ },
    setAiEnabled: async () => { /* answered */ },
    probeReason: (err) => (err instanceof NoTls ? "tls" : null),
    probeMessage: () => null,
    plaintextOffer: (err: unknown) => (err instanceof NoTls ? err.offer : null),
  } as FirstRunHost;
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, {
        children: h(FirstRun, {
          host, facts, onRefresh: () => {}, onLeave: () => {}, add: true,
          pull: { screened: 0, history: 0, pulled: 0 }, decide: null, mailboxId: null,
        }),
      }),
    }));
  });
  const settle = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); };
  const press = async (label: string): Promise<void> => {
    const button = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
    expect(button, `no button labelled ${label}`).toBeTruthy();
    await act(async () => { button!.click(); });
    await settle();
  };
  const type = async (suffix: string, value: string): Promise<void> => {
    const input = el.querySelector<HTMLInputElement>(`input:not([type="checkbox"])[id$='-${suffix}']`);
    expect(input, `no field ending -${suffix}`).toBeTruthy();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    await act(async () => { input!.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const consent = (label: string): HTMLInputElement | null => {
    const row = [...el.querySelectorAll("label")].find((l) => (l.textContent ?? "").includes(label));
    return row?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
  };
  const tick = async (label: string): Promise<void> => {
    const box = consent(label);
    expect(box, `no consent line "${label}"`).toBeTruthy();
    await act(async () => { box!.click(); });
  };
  const generic = el.querySelector<HTMLInputElement>('input[type="radio"][value="imap"]');
  expect(generic, "the add run opens on the mailbox form").toBeTruthy();
  await act(async () => { generic!.click(); });
  await type("address", "pat@home.example");
  await type("pass", "app-password-fixture");
  await type("imap", "mail.home.arpa");
  await type("imap-port", "143");
  await type("smtp", "mail.home.arpa");
  await type("smtp-port", "587");
  return { el, press, type, consent, tick, probed, connected };
}

describe("the add-a-mailbox run and a home mail server without TLS", () => {
  it("offers each protocol its own consent line after that protocol is refused, and sends each only in its block", async () => {
    const ui = await mount(["imap"], ["smtp"]);

    await ui.press("Test connection");
    expect(ui.consent(IMAP_LINE), "no IMAP consent after the IMAP refusal").not.toBeNull();
    expect(ui.consent(SMTP_LINE), "an SMTP line before SMTP refused").toBeNull();
    expect(ui.el.textContent).toContain(copy.insecureConsentWarning);
    expect((ui.probed[0]!.imap as { allowInsecure?: boolean }).allowInsecure).toBeUndefined();

    await ui.tick(IMAP_LINE);
    await ui.press("Test connection");
    expect((ui.probed[1]!.imap as { allowInsecure?: boolean }).allowInsecure).toBe(true);
    expect((ui.probed[1]!.smtp as { allowInsecure?: boolean }).allowInsecure, "the IMAP tick leaked into SMTP").toBeUndefined();

    // The create dials the outgoing server too, and its refusal opens that protocol's line.
    await ui.press(messages.onboarding.connect);
    expect(ui.consent(SMTP_LINE), "no SMTP consent after the SMTP refusal").not.toBeNull();
    expect(ui.consent(IMAP_LINE)!.checked, "the IMAP tick was lost").toBe(true);

    await ui.tick(SMTP_LINE);
    await ui.press("Test connection");
    expect((ui.probed[2]!.smtp as { allowInsecure?: boolean }).allowInsecure).toBe(true);

    await ui.press(messages.onboarding.connect);
    expect(ui.connected).toHaveLength(2);
    expect((ui.connected[1]!.imap as { allowInsecure?: boolean }).allowInsecure).toBe(true);
    expect((ui.connected[1]!.smtp as { allowInsecure?: boolean }).allowInsecure).toBe(true);
  });

  it("a consent is about one server: changing the host takes the line and the tick away", async () => {
    const ui = await mount(["imap"]);
    await ui.press("Test connection");
    await ui.tick(IMAP_LINE);
    await ui.type("imap", "mail2.home.arpa");
    expect(ui.consent(IMAP_LINE)).toBeNull();
    await ui.press("Test connection");
    expect((ui.probed[1]!.imap as { allowInsecure?: boolean }).allowInsecure).toBeUndefined();
  });

  it("a refusal that offers nothing opens no line", async () => {
    const ui = await mount([null]);
    await ui.press("Test connection");
    expect(ui.consent(IMAP_LINE)).toBeNull();
    expect(ui.consent(SMTP_LINE)).toBeNull();
  });
});
