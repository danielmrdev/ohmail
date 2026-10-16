/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * A THREAD OPENS AT THE OPENED MESSAGE, AND STAYS THERE WHILE THE BODIES LAND.
 *
 * The pane puts the `aria-current` panel on screen (the one the bar acts on), not the newest, and
 * re-applies that while sibling bodies land and grow the stack above it, until the reader touches
 * it. jsdom has no layout: the geometry is stubbed on the real elements the effect walks, growth is
 * announced through the `ResizeObserver` it subscribes to, and `scrollTop` is read off the real
 * scroller. `b` is opened in `[a, b, c]`, so the opened and the newest panels cannot coincide.
 */
// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-02T12:00:00.000Z");

function msg(id: string, date: string): Record<string, unknown> {
  return {
    id,
    accountId: "a",
    mailboxId: "mb",
    threadId: "t1",
    messageIdHeader: null,
    subject: id === "a" ? "Quote for the north elevation" : "Re: Quote for the north elevation",
    from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
    to: [],
    cc: [],
    date,
    folder: "INBOX",
    snippet: `snippet-${id}`,
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: date,
  };
}

const A = msg("a", "2026-07-30T09:00:00.000Z");
const B = msg("b", "2026-07-31T09:00:00.000Z");
const C = msg("c", "2026-08-01T09:00:00.000Z");

/**
 * THE FAKE LAYOUT.
 *
 * One number: how tall each rendered message is. The scroller's content height, and therefore
 * where the last entry sits, is derived from it — so "the siblings hydrated" is expressed as
 * the one thing that actually happens, every entry getting taller, and the position the effect
 * should land on falls out of that rather than being asserted from a constant.
 */
const VIEWPORT = 500;
/** Tall enough that three of them overflow the viewport — a stack with nothing to scroll has
    no anchoring question to get wrong, and the walk below correctly declines to move it. */
let entryHeight = 200;
const contentHeight = (): number => entryHeight * 3;
/** Where the OPENED entry (`b`, the second) sits, in the scroller's own coordinates. */
const openedEntryTop = (): number => entryHeight * 1;
/** What the effect should write: the opened entry's top, less its 14px of breathing room. */
const expectedScrollTop = (): number => openedEntryTop() - 14;

/** The ResizeObserver callbacks the pane has subscribed with. */
let observing: Array<() => void> = [];

class FakeResizeObserver {
  private readonly cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe(): void {
    observing.push(this.cb);
  }
  disconnect(): void {
    observing = observing.filter((c) => c !== this.cb);
  }
  unobserve(): void {}
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/**
 * Give the pane's own DOM a geometry. `host` is the scroller (`.read-col` in the product); each
 * `[data-conv-id]` is placed by index, in the scroller's coordinates, offset by however far the
 * scroller has already been scrolled — which is what `getBoundingClientRect` reports.
 */
function stubGeometry(): void {
  const el = host!;
  el.style.overflowY = "auto";
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => contentHeight() });
  el.getBoundingClientRect = (() => ({ top: 0, left: 0, right: 0, bottom: VIEWPORT, width: 600, height: VIEWPORT, x: 0, y: 0, toJSON: () => ({}) })) as never;

  const entries = [...el.querySelectorAll<HTMLElement>("[data-conv-id]")];
  entries.forEach((entry, i) => {
    entry.getBoundingClientRect = (() => {
      const top = entryHeight * i - el.scrollTop;
      return { top, left: 0, right: 0, bottom: top + entryHeight, width: 600, height: entryHeight, x: 0, y: top, toJSON: () => ({}) };
    }) as never;
  });
}

async function mountThread(): Promise<void> {
  const { MessagePane } = await import("../app/shell/MessagePane.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");

  host = document.createElement("div");
  host.className = "read-col";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(MessageChromeProvider as never, {
          value: {
            replyTo: null,
            replyBody: { text: "", html: "" },
            onReplyBody: () => {},
            closeReply: () => {},
            sendReply: () => {},
            replySendState: () => ({ phase: "idle" }),
            openSenderMenu: () => {},
            conversationOf: () => [A, B, C],
            bodyOf: (m: Record<string, unknown>) => ({
              text: m.snippet as string,
              state: "snippet",
              html: null,
              loadedRemoteContent: false,
              unsubscribe: "no_header",
              unsubscribeUrl: null,
            }),
            hydrateBody: () => {},
            // The thread ask moved from `ConversationEntries` up to `MessagePane` — one call per
            // thread open rather than one per half. Inert here: this file measures the scroller.
            hydrateThread: () => {},
          },
          children: h(MessagePane as never, {
            message: B, tags: [], now: NOW,
            onAction: () => {}, onAddTag: () => {}, onAttachment: () => {},
          } as never),
        } as never),
      }),
    );
  });
}

/** The pane anchors in a layout effect, before the geometry exists. Give it one and re-run. */
async function settle(): Promise<void> {
  stubGeometry();
  await act(async () => {
    observing.forEach((cb) => cb());
  });
}

beforeEach(() => {
  entryHeight = 200;
  observing = [];
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

describe("the pane opens a thread on the opened message", () => {
  it("scrolls the opened entry into view, not the newest", async () => {
    await mountThread();
    await settle();
    expect(
      host!.scrollTop,
      "the thread did not open at the opened message",
    ).toBe(expectedScrollTop());
    expect(host!.scrollTop, "the thread opened at its newest message").not.toBe(entryHeight * 2 - 14);
  });

  it("FOLLOWS the stack as the siblings hydrate and push it down", async () => {
    await mountThread();
    await settle();
    const before = host!.scrollTop;

    // Every sibling's body arrives: two lines of snippet become a whole message, three times.
    entryHeight = 340;
    await settle();

    expect(host!.scrollTop, "the pane anchored once and never looked again — the opened message walked off as its older sibling grew")
      .toBe(expectedScrollTop());
    expect(host!.scrollTop).toBeGreaterThan(before);
  });

  it("HANDS OVER the moment the reader touches it, and never moves the scroller again", async () => {
    await mountThread();
    await settle();

    // A wheel gesture anywhere on the page: this reader is reading, and where they are looking
    // is now their decision. Re-anchoring under them would be worse than the bug being fixed.
    await act(async () => {
      window.dispatchEvent(new Event("wheel", { bubbles: true }));
    });
    host!.scrollTop = 0;

    entryHeight = 340;
    await settle();
    expect(host!.scrollTop, "the pane yanked a reader who had scrolled away").toBe(0);
  });
});
