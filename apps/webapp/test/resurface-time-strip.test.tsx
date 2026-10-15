/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { setActiveFormatZone } from "../app/shell/locale";

/**
 * ═══ THE RESURFACE STRIP SHOWS THE TIME, AND A CHOSEN TIME BECOMES THE DEFAULT ═══════════
 * Three claims, measured on the rendered strip: (1) the time control is filled in the moment the
 * strip opens — the account's stored hour, or 09:00 — so nobody has to guess what "Tomorrow"
 * means; (2) the horizons land at the shown time in the READER'S zone, asserted through
 * `Intl.DateTimeFormat` there rather than by slicing the ISO string, because the fixture zone
 * crosses DST inside the window under test; (3) a changed time is remembered, an unchanged one
 * is not, "Now" never is, and the write follows the dispatch. Red on: `hour: 9` left literal in
 * `clockOn`; the `onResurfaceTime` call removed; the input's `value` dropped.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Europe/Zurich, and the clock is set the day BEFORE the 2026 spring change (29 March). So
 * "tomorrow at 14:30" crosses it: the wall clock the reader asked for is 14:30 CEST, which is
 * 12:30Z — an hour off what the same arithmetic would produce on either side of the boundary,
 * and exactly one hour off what an ms-based "+1 day" would mint.
 */
const ZONE = "Europe/Zurich";
const NOW = new Date("2026-03-28T10:00:00.000Z");

/** The wall clock an instant reads as WHERE THE READER IS — the only honest way to assert this. */
function wallClock(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
}

const MESSAGE: Record<string, unknown> = {
  id: "m1", accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
  subject: "subj", from: { name: "Andi", address: "andi@ex.example" }, to: [], cc: [],
  date: "2026-03-28T09:00:00.000Z", folder: "INBOX", snippet: "snip",
  unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-03-28T09:00:00.000Z",
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** Every action the strip dispatched, and every time it asked to remember — in ONE ordered log,
 *  because the CLAIM is that the resurface goes out before the preference is written. */
let log: string[] = [];

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/** The bar alone, through the chrome — the seam the shell supplies the stored time on. */
async function mountBar(opts: { stored?: string | null; canStore?: boolean } = {}): Promise<void> {
  await unmount();
  const { MessageActionBar } = await import("../app/shell/MessagePane.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const chrome: Record<string, unknown> = {
    ownAddresses: [],
    replyTo: null,
    replyBody: { text: "", html: "" },
    onReplyBody: () => {},
    closeReply: () => {},
    sendReply: () => {},
    replySendState: () => ({ phase: "idle" }),
    openSenderMenu: () => {},
    conversationOf: () => [],
    bodyOf: (m: Record<string, unknown>) => ({
      text: m.snippet as string, state: "snippet", html: null,
      loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
    }),
    hydrateBody: () => {},
    hydrateThread: () => {},
    resurfaceTime: opts.stored ?? null,
  };
  // ABSENT, not a no-op stub, where the door cannot store one — that is the state a standalone
  // window is in, and a stub would make the absent arm untestable.
  if (opts.canStore !== false) chrome.onResurfaceTime = (hhmm: string) => log.push(`remember:${hhmm}`);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: ZONE, now: NOW,
        children: h(MessageChromeProvider as never, {
          value: chrome,
          children: h(MessageActionBar as never, {
            message: MESSAGE, now: NOW, onAction: (a: string) => log.push(a),
          } as never),
        } as never),
      }),
    );
  });
}

const byText = (text: string): HTMLElement => {
  const found = [...host!.querySelectorAll("button")]
    .filter((b) => (b.textContent ?? "").trim().startsWith(text));
  expect(found, `expected exactly one button starting "${text}"`).toHaveLength(1);
  return found[0] as HTMLElement;
};
const timeInput = (): HTMLInputElement => {
  const el = host!.querySelector('input[type="time"]');
  expect(el, "the strip drew no time control").not.toBeNull();
  return el as HTMLInputElement;
};
async function openStrip(): Promise<void> {
  await act(async () => { byText("Resurface").click(); });
}
async function typeTime(value: string): Promise<void> {
  const el = timeInput();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  setActiveFormatZone(ZONE);
  log = [];
});

afterEach(async () => {
  await unmount();
  setActiveFormatZone(null);
  vi.useRealTimers();
});

describe("the resurface strip's time", () => {
  it("is shown before any press — the product's 09:00 when the account has chosen nothing", async () => {
    await mountBar();
    await openStrip();
    expect(timeInput().value, "the strip opened with no time in it").toBe("09:00");
  });

  it("is the account's stored time when there is one", async () => {
    await mountBar({ stored: "14:30" });
    await openStrip();
    expect(timeInput().value).toBe("14:30");
  });

  it("falls back to 09:00 for a value no writer could have stored", async () => {
    // Reachable by a hand-run UPDATE alone; the point is that the strip stays usable rather
    // than rendering an hour the horizons cannot mint.
    await mountBar({ stored: "25:00" });
    await openStrip();
    expect(timeInput().value).toBe("09:00");
  });

  it("Tomorrow lands at the shown time, in the reader's zone, across a DST boundary", async () => {
    await mountBar({ stored: "14:30" });
    await openStrip();
    await act(async () => { byText("Tomorrow").click(); });

    const dispatched = log.find((l) => l.startsWith("resurface:"));
    expect(dispatched, "no dated resurface was dispatched").toBeDefined();
    const iso = dispatched!.slice("resurface:".length);
    // 29 March 2026 is the day the zone moves to CEST, so this instant is 12:30Z — the assertion
    // is on the WALL CLOCK, which is what was chosen and what the label reads back.
    expect(wallClock(iso)).toBe("29/03/2026, 14:30");
  });

  it("Tomorrow at the default lands at 09:00 where the reader is", async () => {
    await mountBar();
    await openStrip();
    await act(async () => { byText("Tomorrow").click(); });
    const iso = log.find((l) => l.startsWith("resurface:"))!.slice("resurface:".length);
    expect(wallClock(iso)).toBe("29/03/2026, 09:00");
  });

  it("a time typed into the strip moves the horizon it is pressed with", async () => {
    await mountBar();
    await openStrip();
    await typeTime("07:15");
    await act(async () => { byText("Next week").click(); });
    const iso = log.find((l) => l.startsWith("resurface:"))!.slice("resurface:".length);
    // 30 March 2026 is the coming Monday, and it is past the change — 07:15 CEST, 05:15Z.
    expect(wallClock(iso)).toBe("30/03/2026, 07:15");
  });

  it("a CHANGED time is remembered, AFTER the resurface has been dispatched", async () => {
    await mountBar({ stored: "09:00" });
    await openStrip();
    await typeTime("14:30");
    await act(async () => { byText("Tomorrow").click(); });
    expect(log.filter((l) => l.startsWith("resurface:") || l.startsWith("remember:")))
      .toEqual([expect.stringMatching(/^resurface:/), "remember:14:30"]);
  });

  it("an UNCHANGED time is not remembered — an untouched control is not a decision", async () => {
    await mountBar({ stored: "14:30" });
    await openStrip();
    await act(async () => { byText("Tomorrow").click(); });
    expect(log.some((l) => l.startsWith("remember:")), "the strip wrote a default nobody chose")
      .toBe(false);
  });

  it("Now dispatches the state and remembers nothing — the time cannot apply to it", async () => {
    await mountBar();
    await openStrip();
    await typeTime("14:30");
    await act(async () => { byText("Now").click(); });
    expect(log).toEqual(["resurface_now"]);
  });

  it("a door that cannot store one still chooses — the strip never withholds the time", async () => {
    await mountBar({ canStore: false });
    await openStrip();
    await typeTime("14:30");
    await act(async () => { byText("Tomorrow").click(); });
    const iso = log.find((l) => l.startsWith("resurface:"))!.slice("resurface:".length);
    expect(wallClock(iso), "the standalone window lost the chosen hour").toBe("29/03/2026, 14:30");
    expect(log.some((l) => l.startsWith("remember:"))).toBe(false);
  });

  it("the horizons say the time out loud — a screen reader hears what a reader sees", async () => {
    await mountBar({ stored: "14:30" });
    await openStrip();
    expect(byText("Tomorrow").getAttribute("aria-label")).toBe("Tomorrow, 14:30");
    expect(byText("Next week").getAttribute("aria-label")).toBe("Next week, 14:30");
    /* NARROWED, not weakened. "Pick a date" carried the asked hour and could not honour it: a day
       on either of the two nights books a different one, and this button names no day. The hour
       moved to the popover's cells, where it is composed per day — `resurface-dst` asserts them. */
    expect(byText("Pick a date").getAttribute("aria-label")).toBeNull();
    // "Now" carries none either: it ignores the time, and an accessible name claiming otherwise
    // would be the one place this strip could lie.
    expect(byText("Now").getAttribute("aria-label")).toBeNull();
    // The field's accessible name is its VISIBLE label — one string, so a screen reader and a
    // sighted reader cannot be told different words about the same control.
    const label = host!.querySelector(`label[for="${timeInput().id}"]`);
    expect(label, "the time field has no label pointing at it").not.toBeNull();
    expect(label!.textContent).toBe("Time");
  });

  it("a cleared field keeps the last real time rather than minting from a hidden fallback", async () => {
    await mountBar({ stored: "14:30" });
    await openStrip();
    await typeTime("");
    expect(timeInput().value, "an emptied control silently became 09:00").toBe("14:30");
  });
});
