/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import type { FirstRunHost, FirstRunOrganizeOutcome } from "../app/shell/first-run-host";
import type { OnboardingFacts } from "../app/shell/onboarding";

/**
 * AGREE MEETS THE DOOR'S SECOND-FACTOR CHECK. On the self-hosted server the consent
 * route is step-up gated; past the window it answered 403 and setup stepped back to the consent
 * statement with no sentence and no code prompt, and Close setup then said "what you agreed to
 * stays agreed". Now the step stays, says so, asks with the host's prompt and presses once more.
 * HOW TO WATCH IT FAIL: drop `{ stayOnFailure: true }` from the Agree press in `FirstRun.tsx`.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const t = messages.onboarding;

class StepUpRequired extends Error { code = "step_up_required"; }

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
});

async function mount(answers: Array<"step_up" | FirstRunOrganizeOutcome>) {
  let current: OnboardingFacts = {
    door: "selfhost",
    mailbox: {
      organizerRole: "reader", organizedBy: null, organizerState: null,
      organizeConsentedAt: null, initialImportCompletedAt: "2026-09-26T09:29:00.000Z",
    },
    // AI already answered, so Agree walks straight on to Done.
    account: { onboardingCompletedAt: null }, ai: "off", queuedSenders: 0,
  };
  const presses: Array<Record<string, unknown>> = [];
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  let bump: (() => void) | null = null;
  const host: FirstRunHost = {
    door: "selfhost", ai: current.ai,
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => ({ id: "mb-1" }),
    organize: async (_id, body) => {
      presses.push(body as Record<string, unknown>);
      const a = answers.shift() ?? "stored";
      if (a === "step_up") throw new StepUpRequired("step-up required");
      if (a === "stored") {
        current = { ...current, mailbox: { ...current.mailbox!, organizeConsentedAt: "2026-09-26T09:31:00.000Z" } };
      }
      return a;
    },
    complete: async () => { /* stamped */ },
    setAiEnabled: async () => { /* answered */ },
    probeReason: () => null,
    probeMessage: () => null,
    stepUp: {
      required: (err) => (err as { code?: string })?.code === "step_up_required",
      prompt: (p) => h("div", { className: "prompt" },
        h("button", { type: "button", onClick: p.onVerified }, "Verify code"),
        h("button", { type: "button", onClick: p.onCancel }, "Cancel code")),
    },
  };
  const Stage = () => {
    const [, set] = React.useState(0);
    bump = () => set((n) => n + 1);
    return h(FirstRun, {
      host, facts: current, onRefresh: () => bump?.(), onLeave: () => { /* left */ },
      pull: { screened: 0, history: 0, pulled: 0 }, decide: null, mailboxId: "mb-1",
    });
  };
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, { children: h(Stage, null) }),
    }));
  });
  const button = (label: string) =>
    [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
  return {
    heading: () => (el.querySelector("h1")?.textContent ?? "").trim(),
    text: () => el.textContent ?? "",
    has: (label: string) => button(label) !== undefined,
    press: async (label: string) => {
      const b = button(label);
      if (!b) throw new Error(`no button labelled ${JSON.stringify(label)}`);
      await act(async () => { b.click(); for (let i = 0; i < 16; i++) await Promise.resolve(); });
    },
    presses,
  };
}

async function toWindow(s: Awaited<ReturnType<typeof mount>>) {
  await s.press(t.continue);
  expect(s.heading()).toBe(t.windowTitle);
}

describe("Agree over the door's second-factor check", () => {
  it("403 step_up_required: the step stays, says so, and asks for the code", async () => {
    const s = await mount(["step_up"]);
    await toWindow(s);
    await s.press(t.agree);
    expect(s.heading(), "setup stepped back in silence").toBe(t.windowTitle);
    expect(s.text()).toContain(t.windowStepUp);
    expect(s.has("Verify code"), "no code prompt").toBe(true);
  });

  it("a verified code presses once more, and setup goes on", async () => {
    const s = await mount(["step_up", "stored"]);
    await toWindow(s);
    await s.press(t.agree);
    await s.press("Verify code");
    expect(s.presses, "the same press ran twice").toHaveLength(2);
    expect(s.presses[1]).toEqual(s.presses[0]);
    expect(s.heading()).not.toBe(t.windowTitle);
    expect(s.heading()).not.toBe(t.consentTitle);
  });

  it("a second refusal after the code is said, and is not asked again", async () => {
    const s = await mount(["step_up", "step_up"]);
    await toWindow(s);
    await s.press(t.agree);
    await s.press("Verify code");
    expect(s.presses).toHaveLength(2);
    expect(s.heading()).toBe(t.windowTitle);
    expect(s.text()).toContain(t.windowStepUp);
    expect(s.has("Verify code"), "a second prompt: the retry is once").toBe(false);
  });

  it("CONTROL: an answer that stores goes on with no prompt", async () => {
    const s = await mount(["stored"]);
    await toWindow(s);
    await s.press(t.agree);
    expect(s.presses).toHaveLength(1);
    expect(s.has("Verify code")).toBe(false);
    expect(s.heading()).not.toBe(t.windowTitle);
  });

  it("Done after Agree on a mailbox nothing holds says organizing is starting, not 'it reads'", async () => {
    const s = await mount(["stored"]);
    await toWindow(s);
    await s.press(t.agree);
    // AI, then the pull or Done: walk forward until Done.
    for (let i = 0; i < 4 && s.heading() !== t.doneReaderTitle && s.heading() !== t.doneTitle; i++) {
      if (s.has(t.continue)) await s.press(t.continue);
      else if (s.has(t.pullLeave)) await s.press(t.pullLeave);
    }
    expect(s.text()).toContain(t.doneStartLands);
    expect(s.text(), "Done said this computer only reads").not.toContain(t.doneReaderReads);
  });

  it("Close setup after a refused Agree does not say anything was agreed", async () => {
    const s = await mount(["step_up"]);
    await toWindow(s);
    await s.press(t.agree);
    await s.press("Cancel code");
    await s.press(t.cancel);
    expect(s.text()).toContain(t.cancelWhatNothingAgreed);
    expect(s.text()).not.toContain(t.cancelWhat);
  });
});
