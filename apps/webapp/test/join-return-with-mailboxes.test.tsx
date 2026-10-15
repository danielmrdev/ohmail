/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * A PAID RETURN TO THE WIZARD FOR AN ACCOUNT THAT ALREADY HAS A MAILBOX goes where the wizard's
 * own bootstrap sends an entitled account with one: the done step, never "Connect a mailbox".
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let originalFetch: typeof globalThis.fetch;
let accessReads = 0;
let mailboxItems: unknown[] = [];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const enrolled = {
  user: {
    userId: "u_A", accountId: "acct_A", email: "a@example.invalid", displayName: "Pat",
    emailVerified: true, twofaEnrolled: { webauthn: true, totp: false, recoveryCodes: true },
  },
  scope: "full",
};

const MAILBOX = {
  id: "mbx_1", address: "pat@example.invalid", provider: "imap", status: "connected",
  organizerRole: "reader", createdAt: "2026-09-10T00:00:00.000Z",
};

beforeEach(async () => {
  const { forgetAccess } = await import("../app/api-client");
  forgetAccess();
  accessReads = 0;
  mailboxItems = [MAILBOX];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/auth/session")) return json(enrolled);
    if (url.includes("/account/access")) {
      accessReads += 1;
      // The bootstrap's read finds the account unpaid; every read after the return finds it paid.
      return json({ metered: true, canAddMailbox: accessReads > 1, mailboxes: accessReads > 1 ? 3 : 0 });
    }
    if (url.includes("/account/checkout/confirm")) return json({ state: "confirmed" });
    if (url.includes("/account/manage-link")) return json({ url: "https://account.example/m" });
    if (url.includes("/mailboxes")) return json({ items: mailboxItems });
    return json({});
  }) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function mountReturn(): Promise<HTMLElement> {
  const { JoinScreen } = await import("../app/(product)/join/JoinScreen.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(JoinScreen, { initialCode: "", publicSignup: false, billingReturn: "success" }),
    }));
    await Promise.resolve();
  });
  for (let i = 0; i < 12; i += 1) await act(async () => { await Promise.resolve(); });
  return host;
}

describe("the paid return for an account that already has a mailbox", () => {
  it("lands on the done step with the mailbox named, never the connect step", async () => {
    const c = await mountReturn();
    expect(accessReads, "the return's poll never read access, so this proves nothing").toBeGreaterThan(1);
    expect(c.textContent).not.toContain(messages.join.step_mailbox_lead);
    expect(c.textContent).toContain("pat@example.invalid");
  });

  it("CONTROL: an account with no mailbox is still asked to connect one", async () => {
    mailboxItems = [];
    const c = await mountReturn();
    expect(accessReads).toBeGreaterThan(1);
    expect(c.textContent).toContain(messages.join.step_mailbox_lead);
  });
});
