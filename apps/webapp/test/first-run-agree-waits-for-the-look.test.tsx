/** @vitest-environment jsdom */
import { describe, expect, it, afterEach, vi } from "vitest";
import * as React from "react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { FirstRun, HOLDER_CHECK_MS } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import { holderAnswered } from "../app/shell/reader-holder";
import type { FirstRunHost, FirstRunOrganizeOutcome } from "../app/shell/first-run-host";
import type { OnboardingFacts, OnboardingMailbox } from "../app/shell/onboarding";

/**
 * AGREE WAITS FOR THE FIRST LOOK AT WHO HOLDS THE MAILBOX. A second computer's
 * How-far-back step offered "Agree and start organizing" for 11-26 s before the claim question
 * landed, and a press in that window took a live organizer's mailbox. The step now waits while
 * the door says it has not looked (`organizerChecked: false`), a live holder lands on the claim
 * question, and only "Organize here instead" sends the takeover verb. HOW TO WATCH IT FAIL: make
 * `holderAnswered` answer `true` — the waiting case goes red.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const t = messages.onboarding;

const UNLOOKED: OnboardingMailbox = {
  organizerRole: "reader", organizedBy: null, organizerState: null, organizerChecked: false,
  organizeConsentedAt: null, initialImportCompletedAt: null,
};
const NOBODY: OnboardingMailbox = { ...UNLOOKED, organizerChecked: undefined };
const LIVE: OnboardingMailbox = {
  ...NOBODY, organizedBy: { kind: "local", name: "W-live", since: "2026-09-26T08:00:00.000Z" },
  organizerState: "held", organizerEventAt: "2026-09-26T08:17:50.000Z",
};
const STOPPED: OnboardingMailbox = { ...LIVE, organizerState: "stopped" };

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
  vi.useRealTimers();
});

async function mount(first: OnboardingMailbox, answer: () => FirstRunOrganizeOutcome = () => "stored") {
  let current: OnboardingFacts = {
    door: "local", mailbox: first, account: { onboardingCompletedAt: null }, ai: "unset", queuedSenders: 0,
  };
  const organizedWith: Array<Record<string, unknown>> = [];
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  let bump: (() => void) | null = null;
  const host: FirstRunHost = {
    door: "local", ai: current.ai,
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => ({ id: "mb-1" }),
    organize: async (_id, body) => {
      organizedWith.push(body as Record<string, unknown>);
      const out = answer();
      if (out === "stored") {
        current = { ...current, mailbox: { ...current.mailbox!, organizeConsentedAt: "2026-09-26T08:18:00.000Z" } };
      }
      return out;
    },
    complete: async () => { /* stamped */ },
    setAiEnabled: async () => { /* answered */ },
    probeReason: () => null,
    probeMessage: () => null,
  };
  const Stage = () => {
    const [, set] = React.useState(0);
    bump = () => set((n) => n + 1);
    return h(FirstRun, {
      host, facts: current, onRefresh: () => bump?.(), onLeave: () => { /* left */ },
      pull: { screened: 0, history: 0, pulled: 0 }, decide: null, mailboxId: "mb-1",
      organizedSince: "26 Sept 2026",
    });
  };
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, { children: h(Stage, null) }),
    }));
  });
  const button = (label: string) =>
    [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label)) as HTMLButtonElement | undefined;
  return {
    heading: () => (el.querySelector("h1")?.textContent ?? "").trim(),
    text: () => el.textContent ?? "",
    agree: () => button(t.agree),
    press: async (label: string) => {
      const b = button(label);
      if (!b) throw new Error(`no button labelled ${JSON.stringify(label)}`);
      await act(async () => { b.click(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
    },
    /** Enter on the step's form — the keyboard's road to the same press. */
    submit: async () => {
      await act(async () => {
        el.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });
    },
    /** The door's next read, as the shell's poll delivers it. */
    read: async (mailbox: OnboardingMailbox) => {
      current = { ...current, mailbox: { ...mailbox, organizeConsentedAt: current.mailbox!.organizeConsentedAt } };
      await act(async () => { bump?.(); });
    },
    organizedWith,
  };
}

/** Consent, then Continue to How far back. */
async function toWindow(s: Awaited<ReturnType<typeof mount>>) {
  expect(s.heading()).toBe(t.consentTitle);
  await s.press(t.continue);
  expect(s.heading()).toBe(t.windowTitle);
}

describe("How far back waits for the first look", () => {
  it("before the look answers, Agree is withheld and a press takes nothing", async () => {
    const s = await mount(UNLOOKED);
    await toWindow(s);
    expect(s.text()).toContain(t.windowCheckingHolder);
    expect(s.agree()?.disabled, "Agree was offered before anybody looked").toBe(true);
    await s.press(t.agree);
    await s.submit();
    expect(s.organizedWith, "a press before the look reached the door").toEqual([]);
  });

  it("the look lands a LIVE holder: the claim question, and Organize here instead names the takeover", async () => {
    const s = await mount(UNLOOKED);
    await toWindow(s);
    await s.read(LIVE);
    expect(s.heading(), "the claim question did not come").toBe(t.elsewhereTitle);
    await s.press(t.continue);
    await s.press(t.continue);
    expect(s.heading()).toBe(t.windowTitle);
    await s.press(t.agree);
    expect(s.organizedWith.map((b) => b.intent)).toEqual(["takeover"]);
  });

  it("CONTROL: the look lands nobody — Agree is offered and the press is a join", async () => {
    const s = await mount(UNLOOKED);
    await toWindow(s);
    await s.read(NOBODY);
    expect(s.text()).not.toContain(t.windowCheckingHolder);
    expect(s.agree()?.disabled).toBe(false);
    await s.press(t.agree);
    expect(s.organizedWith.map((b) => b.intent)).toEqual(["join"]);
  });

  it("CONTROL: the look lands a STOPPED holder — the claim question, and its default still claims", async () => {
    const s = await mount(UNLOOKED);
    await toWindow(s);
    await s.read(STOPPED);
    expect(s.heading()).toBe(t.elsewhereTitleStopped);
    await s.press(t.continue);
    await s.press(t.continue);
    await s.press(t.agree);
    expect(s.organizedWith.map((b) => b.intent)).toEqual(["takeover"]);
  });

  it("the door refuses over a holder the screen had not seen: nothing stored, the claim question next", async () => {
    let refuse = true;
    const s = await mount(NOBODY, () => (refuse ? "held" : "stored"));
    await toWindow(s);
    await s.read(NOBODY);
    // The door has read the holder the window's facts do not show yet, and refuses the join.
    await s.press(t.agree);
    refuse = false;
    await s.read(LIVE);
    expect(s.organizedWith.map((b) => b.intent)).toEqual(["join"]);
    expect(s.heading()).toBe(t.elsewhereTitle);
  });

  it("the wait is bounded: past HOLDER_CHECK_MS Agree is offered, as a join", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = await mount(UNLOOKED);
    await toWindow(s);
    expect(s.agree()?.disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(HOLDER_CHECK_MS + 1); });
    expect(s.agree()?.disabled).toBe(false);
    await s.press(t.agree);
    expect(s.organizedWith.map((b) => b.intent)).toEqual(["join"]);
  });
});

describe("holderAnswered reads the door's look", () => {
  it("a reader row the door has not looked at is the only no", () => {
    expect(holderAnswered({ organizerRole: "reader", organizerChecked: false })).toBe(false);
    expect(holderAnswered({ organizerRole: "reader" })).toBe(true);
    expect(holderAnswered({ organizerRole: "organizer", organizerChecked: false })).toBe(true);
    expect(holderAnswered(null)).toBe(true);
  });
  it("both catalogues carry the checking sentence", () => {
    expect(t.windowCheckingHolder).toBeTruthy();
    expect(de.onboarding.windowCheckingHolder).toBeTruthy();
  });
});

/**
 * THE CENSUS OF EVERY PRESS THAT REACHES AN ORGANIZE DOOR, BY CALL. The local door now reads an
 * absent verb as a join, so a caller that meant a takeover and said nothing would turn a person's
 * "Organize here" into a press that yields — this row's defect in reverse. Each call is listed with
 * the verb it ends up carrying, and the server lines that make it so are read beside it.
 */
describe("census: every organize press carries the verb it means", () => {
  const REPO = join(__dirname, "..", "..", "..");
  const ROOTS = ["apps/webapp/app", "apps/desktop/src", "apps/mobile/src", "apps/mobile/app"];
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "build" || name === ".next") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };
  const code = (rel: string) => withoutComments(readFileSync(join(REPO, rel), "utf8"));
  /** A press: a call naming an organize route or an organize method. */
  const PRESS = /host\.organize\(|mailboxApi\.organize\(|organizePath\(mailboxId\)|\/organize`|"\/local\/organizer\/takeover"/g;

  /** file → how many presses, and what each one ends up asking for. */
  const EXPECTED: Record<string, { presses: number; verb: string }> = {
    // The shared setup: the re-entry press names the takeover; Agree names it only after
    // "Organize here instead", a join otherwise.
    "apps/webapp/app/shell/FirstRun.tsx": { presses: 2, verb: "takeover only by the person's choice" },
    // The desktop host forwards the verb FirstRun chose to the local door (its route builder and
    // its one call).
    "apps/desktop/src/local-first-run.ts": { presses: 2, verb: "forwards FirstRun's verb" },
    // The web host forwards it to the hosted door, which reads absent as takeover.
    "apps/webapp/app/(product)/mailbox/useCloudFirstRun.ts": { presses: 1, verb: "forwards FirstRun's verb" },
    // Settings → Mailboxes "Organize here" on the web: the hosted door, absent = takeover.
    "apps/webapp/app/(product)/mailbox/MailboxSection.tsx": { presses: 1, verb: "takeover (hosted default)" },
    // Settings → Mailboxes "Organize from this machine" on the desktop: the takeover route.
    "apps/desktop/src/DesktopMailboxes.tsx": { presses: 1, verb: "takeover (its own route)" },
    // The phone's consent: its door stamps join over every consent and has no takeover verb.
    "apps/mobile/src/net/mailboxes.ts": { presses: 1, verb: "join (the phone door stamps it)" },
    // The client's own route builder, called by MailboxSection and useCloudFirstRun above.
    "apps/webapp/app/api-client.ts": { presses: 1, verb: "the route builder" },
  };

  it("names every press across the four roots, and no other", () => {
    const files = ROOTS.flatMap((r) => walk(join(REPO, r)));
    expect(files.length, "the walk read nothing").toBeGreaterThan(100);
    const found: Record<string, number> = {};
    for (const f of files) {
      const n = (code(relative(REPO, f)).match(PRESS) ?? []).length;
      if (n > 0) found[relative(REPO, f)] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, v.presses])));
  });

  it("each press carries the verb its row says", () => {
    const firstRun = code("apps/webapp/app/shell/FirstRun.tsx");
    expect(firstRun).toMatch(/host\.organize\(mailboxId, \{ intent: "takeover" \}\)/);
    expect(firstRun).toMatch(/const intent = claimAnsweredFor === mailboxId && elsewhereChoice === "here" \? "takeover" : "join";/);
    expect(firstRun.match(/host\.organize\(mailboxId, \{[\s\S]*?intent,\s*\}\)/g) ?? []).toHaveLength(1);
    expect(code("apps/desktop/src/local-first-run.ts")).toMatch(/\.\.\.\(body\.intent \? \{ intent: body\.intent \} : \{\}\)/);
    expect(code("apps/webapp/app/(product)/mailbox/useCloudFirstRun.ts")).toMatch(/mailboxApi\.organize\(id, body\)/);
    expect(code("apps/webapp/app/(product)/mailbox/MailboxSection.tsx")).toMatch(/mailboxApi\.organize\(id\)/);
    // The server lines that decide what an absent or a named verb means on each door.
    expect(code("apps/sidecar/src/engine.ts")).toMatch(/const intent = body\.intent === "takeover" \? "takeover" : "join";/);
    expect(code("apps/sidecar/src/engine.ts")).toMatch(/mailboxId, now: now\(\), intent: "takeover",/);
    expect(code("packages/api/src/routes/mailboxes.ts")).toMatch(/intent: body\.intent === "join" \? "join" : "takeover"/);
    expect(code("apps/sidecar/src/mobile.ts")).toMatch(/intent: "join" \}\)/);
  });

  it("POSITIVE CONTROL: the press pattern finds a planted call and ignores one in a comment", () => {
    expect(withoutComments("await host.organize(id, {});").match(PRESS)).toHaveLength(1);
    expect(withoutComments("// await host.organize(id, {});\nconst a = 1;").match(PRESS)).toBeNull();
  });
});
