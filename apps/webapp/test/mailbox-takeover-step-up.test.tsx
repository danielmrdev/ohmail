/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import { ApiError, type MailboxDTO, type SubscriptionStatus } from "../app/api-client";
import type { MailState } from "../app/shell/mail-state";

/**
 * ═══ A STEP-UP REFUSAL ON THE TAKE-OVER OPENS THE PROMPT, IT DOES NOT END THE PRESS ════════
 *
 * `POST /mailboxes/:id/organize` is step-up gated, so a press on a closed five-minute window
 * answers 403. The pane used to print the refusal and stop, on the one row whose ONLY remedy is
 * that press: a mailbox the organizer lease stood down offers a take-over and nothing else.
 *
 * The gating does not change and the window is not widened. What is pinned is where a refusal
 * LEAVES somebody: the same `StepUpPrompt` the create, the edit and the removal park behind, with
 * the press held across it and made again the instant a factor verifies — on the session the
 * browser holds, never a sign-in.
 *
 * ── HOW TO WATCH THESE FAIL ────────────────────────────────────────────────────────────────
 *
 *  · drop the `park` in `pressTakeover` → the prompt never opens and the first case goes red;
 *  · re-run nothing from the prompt's `onVerified` → the third case goes red with `organize`
 *    called once;
 *  · admit every refusal to the prompt instead of the step-up one → the second case goes red.
 */

const copy = en.mailboxes as unknown as Record<string, string>;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  mailboxes: null, mirrored: 0, freshness: { state: "unknown", asOf: null },
} as unknown as MailState;

const healthy = { status: "active", plan: "pro", credits: 100 } as unknown as SubscriptionStatus;

let mockListed: MailboxDTO[] = [];
/** Every id `POST /mailboxes/:id/organize` was asked for, in order. */
let mockOrganizeCalls: string[] = [];
/** What that route answers on the NEXT call — shifted, so a retry can be told from the first try. */
let mockOrganizeAnswers: Array<() => { outcome: string }> = [];
let mockLoginCalls = 0;
let mockStepUpCalls = 0;

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({
        user: {
          email: "person@example.test", emailVerified: true, accountId: "acc1",
          twofaEnrolled: { webauthn: false, totp: true },
        },
        scope: "full",
      }),
      login: async () => {
        mockLoginCalls += 1;
        return { status: "twofa_required", loginToken: "lt1", methods: ["totp"] };
      },
      stepUpTotp: async () => { mockStepUpCalls += 1; return { ok: true }; },
    },
    billing: { subscription: async () => ({ entitlements: null, subscription: healthy }) },
    mailboxes: {
      list: async () => ({ items: mockListed }),
      organizer: async () => ({ holders: [], unreadable: 0 }),
      organize: async (id: string) => {
        mockOrganizeCalls.push(id);
        const next = mockOrganizeAnswers.shift();
        if (!next) return { outcome: "authorized" };
        return next();
      },
    },
  };
});

const stepUp = (): never => {
  throw new ApiError(403, "step_up_required", "Confirm it is you before making this change.");
};
const taken = (): never => {
  throw new ApiError(409, "mailbox_exists", "This mailbox is already connected to your account.");
};

/**
 * THE ROW MIGRATION 0083 DELIBERATELY LEFT BEHIND: `disabled` with the lease's own reason, which
 * `readerStandDown`'s legacy arm reads and this pane renders with the take-over on it.
 */
const legacyStandDown = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "imap", address: "person@example.test",
  displayName: null, status: "disabled", disabledReason: "organized_elsewhere:local",
  lastSyncAt: "2026-09-04T09:20:00.000Z", createdAt: "2026-08-01T10:00:00.000Z",
  organizerRole: "reader",
  organizedBy: { kind: "local", name: "a laptop", since: "2026-09-01T08:00:00.000Z" },
  organizerState: "held",
  organizeConsentedAt: "2026-08-01T10:05:00.000Z",
  organizerReleasedAt: null,
  ...over,
} as MailboxDTO);

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

async function mount(...items: MailboxDTO[]): Promise<HTMLDivElement> {
  await unmount();
  mockListed = items;
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages: en as never, children: h(MailboxSection),
    }));
  });
  await settle();
  return host;
}

function button(el: HTMLElement, text: string): HTMLElement {
  const found = [...el.querySelectorAll("button, a")]
    .filter((n) => (n.textContent ?? "").trim() === text);
  // A COUNT-REFUSING MATCH: two candidates mean the press is ambiguous and neither is pressed.
  expect(found.length, `expected exactly one control reading "${text}", found ${found.length}`).toBe(1);
  return found[0] as HTMLElement;
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

async function type(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
}

/** Press the row's take-over through the two steps the stand-down branch draws. */
async function pressTakeover(el: HTMLElement): Promise<void> {
  await click(button(el, copy.organizerCheck!));
  await click(button(el, copy.organizerConfirm!));
}

beforeEach(() => {
  mockListed = [];
  mockOrganizeCalls = [];
  mockOrganizeAnswers = [];
  mockLoginCalls = 0;
  mockStepUpCalls = 0;
});
afterEach(async () => { await unmount(); });

const promptOf = (el: HTMLElement): Element | null => el.querySelector('[data-testid="step-up-prompt"]');

describe("the take-over's step-up refusal", () => {
  it("opens the same step-up prompt the connect, the edit and the removal park behind", async () => {
    mockOrganizeAnswers = [stepUp];
    const el = await mount(legacyStandDown());
    await pressTakeover(el);

    expect(mockOrganizeCalls, "the press never reached the route").toEqual(["mb1"]);
    expect(promptOf(el), "a step-up refusal left the person on the list with no way forward").not.toBeNull();
    expect(el.querySelector('input[type="password"]'), "the take-over asked for a password").toBeNull();
  });

  it("does NOT open it for a refusal that a second factor cannot fix", async () => {
    mockOrganizeAnswers = [taken];
    const el = await mount(legacyStandDown());
    await pressTakeover(el);

    const said = el.textContent ?? "";
    expect(promptOf(el), "an unrelated refusal was answered with a second-factor prompt").toBeNull();
    expect(said, "the refusal's own sentence never reached the screen")
      .toContain("already connected");
  });

  it("holds the ask across the prompt and presses it again when the factor verifies", async () => {
    mockOrganizeAnswers = [stepUp];
    const el = await mount(legacyStandDown());
    await pressTakeover(el);

    const code = el.querySelector("#stepup-code");
    expect(code, "the prompt did not render a code field").not.toBeNull();
    await type(code as HTMLInputElement, "123456");
    await submit((code as HTMLElement).closest("form") as HTMLFormElement);

    expect(mockStepUpCalls, "the factor was never verified").toBe(1);
    expect(mockLoginCalls, "the take-over signed in again — one more web session").toBe(0);
    // THE WHOLE POINT: the ask survived the prompt and was made again, for the SAME mailbox.
    expect(mockOrganizeCalls, "the verified factor did not re-press the take-over")
      .toEqual(["mb1", "mb1"]);
    // And the pane lands back on the list rather than sitting on the prompt.
    expect(promptOf(el), "the prompt did not close").toBeNull();
  });
});
