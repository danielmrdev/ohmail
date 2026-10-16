/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { setActiveFormatZone } from "../app/shell/locale";

/**
 * THE SENDER'S CIRCLE IS ON EVERY VIEWER PANEL, AND IT IS THE LIST'S CIRCLE.
 *
 * The list and the open message describe the same person, so they must wear the same face:
 * the small initials circle, derived the one way everything derives it — the display name's
 * first letter (the address's where there is no name), and a hue that is a pure function of
 * the ADDRESS (`avatarHue`, `format.ts`). The viewer redesign put a `MessageHeader` on every
 * per-message panel; before it, the reading pane had NO circle at all, which is how a thread
 * could show its people in the list and then drop them the moment it was opened. These guards
 * hold the repaired state:
 *
 *   · EVERY panel header carries its own sender's circle — the focused message and each
 *     conversation sibling alike, and the single-message pane too.
 *   · The derivation is IDENTICAL to the list's, asserted DOM-to-DOM: a `MessageRow` drawn for
 *     the same people carries the same letter and the same `--av-h` on its lead and on its
 *     strip faces as the viewer's headers do. A viewer that keyed the hue on the display name,
 *     or took its initial from somewhere else, goes red here — that is the drift this file
 *     exists to catch, because each half looks completely normal on its own.
 *   · The derivation is DETERMINISTIC: same input, same output, no per-render or per-session
 *     free variable. (The hue table itself is pinned in `shell-screening-bulk.test.ts`.)
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-02T12:00:00.000Z");

/** Two voices, deliberately unalike: a named sender, and a bare address with no display name —
 * the fallback derivation (first letter of the LOCAL PART) is part of what is under guard. */
const ANDI = { name: "Andi Berger", address: "andi@bergerweb.example" };
const BARE = { name: null, address: "mila@trafficflow.example" };

function msg(
  id: string,
  from: { name: string | null; address: string },
  date: string,
  threadId: string | null,
): Record<string, unknown> {
  return {
    id,
    accountId: "a",
    mailboxId: "mb",
    threadId,
    messageIdHeader: null,
    subject: `subj-${id}`,
    from,
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

const A = msg("a", ANDI, "2026-07-30T09:00:00.000Z", "t1");
const G = msg("g", BARE, "2026-07-31T09:00:00.000Z", "t1");

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let conversation: Array<Record<string, unknown>> = [];

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/** The production seam, exactly as `conversation.test.ts` mounts it: the pane through the chrome. */
async function mountPane(open: Record<string, unknown>): Promise<void> {
  await unmount();
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
            ownAddresses: [],
            replyTo: null,
            replyBody: { text: "", html: "" },
            onReplyBody: () => {},
            closeReply: () => {},
            sendReply: () => {},
            replySendState: () => ({ phase: "idle" }),
            openSenderMenu: () => {},
            conversationOf: () => conversation,
            bodyOf: (m: Record<string, unknown>) => ({
              text: m.snippet as string,
              state: "snippet",
              html: null,
              loadedRemoteContent: false,
              unsubscribe: "no_header",
              unsubscribeUrl: null,
            }),
            hydrateBody: () => {},
            hydrateThread: () => {},
          },
          children: h(MessagePane as never, {
            message: open,
            tags: [],
            now: NOW,
            onAction: () => {},
            onAddTag: () => {},
            onAttachment: () => {},
          } as never),
        } as never),
      }),
    );
  });
}

/** A rendered circle, reduced to the two derived facts under guard. */
interface Face { letter: string; hue: string }
const faceOf = (el: Element | null): Face => {
  expect(el, "expected an .av circle here").not.toBeNull();
  return {
    letter: (el as HTMLElement).textContent ?? "",
    hue: (el as HTMLElement).style.getPropertyValue("--av-h"),
  };
};
/** The circle a viewer panel's header wears. */
const headerFace = (convId: string): Face =>
  faceOf(host!.querySelector(`[data-conv-id="${convId}"] .msg-sender .av`));

beforeEach(() => {
  vi.useFakeTimers();
  setActiveFormatZone("UTC");
  conversation = [];
});

afterEach(async () => {
  await unmount();
  setActiveFormatZone(null);
  vi.useRealTimers();
});

describe("every viewer panel header wears its sender's circle", () => {
  it("a conversation: the focused panel and each sibling carry their OWN sender's face", async () => {
    // Mutation that must go red: remove the <Avatar> from `MessageHeader` (MessageCard.tsx) —
    // every face below is missing. The header is ONE component worn by both panel kinds, so
    // one mutation point covers the focused message and the siblings alike.
    conversation = [A, G];
    await mountPane(A);

    const { avatarHue, initialsOf, senderName } = await import("../app/shell/format.js");
    const andi = headerFace("a");
    expect(andi.letter).toBe("A");
    expect(andi.letter).toBe(initialsOf(senderName(A as never)));
    expect(andi.hue).toBe(String(avatarHue(ANDI.address)));

    // The no-name sender: the letter falls back to the address's local part — and the hue is
    // keyed on the ADDRESS either way, so a person is one colour with or without a name.
    const mila = headerFace("g");
    expect(mila.letter).toBe("M");
    expect(mila.letter).toBe(initialsOf(senderName(G as never)));
    expect(mila.hue).toBe(String(avatarHue(BARE.address)));
  });

  it("a single message keeps the same circle in its one header", async () => {
    conversation = [];
    await mountPane(msg("solo", ANDI, "2026-07-30T09:00:00.000Z", null));
    const { avatarHue } = await import("../app/shell/format.js");
    const face = faceOf(host!.querySelector(".msg .msg-sender .av"));
    expect(face.letter).toBe("A");
    expect(face.hue).toBe(String(avatarHue(ANDI.address)));
  });
});

describe("the list and the viewer derive one identity per address", () => {
  it("a MessageRow's lead and strip faces carry the SAME letter and hue as the viewer's headers", async () => {
    // The viewer half.
    conversation = [A, G];
    await mountPane(A);
    const viewer = { a: headerFace("a"), g: headerFace("g") };

    // The list half: a row drawn with the shell's own derivation for the same people — the
    // lead via `avatarOf`, the strip via the `initialsOf`/`avatarHue` pair `participantsOf`
    // binds (`AppShell.tsx`). DOM-to-DOM, so a viewer that re-derived either fact its own way
    // (hue off the display name, initial off something else) splits the two and goes red.
    const { MessageRow } = await import("@ohmail/ui");
    const { avatarOf, avatarHue, initialsOf } = await import("../app/shell/format.js");
    const participants = [ANDI, BARE].map((p) => ({
      initials: initialsOf(p.name || p.address),
      hue: avatarHue(p.address),
    }));
    const rowHost = document.createElement("div");
    document.body.appendChild(rowHost);
    const rowRoot = createRoot(rowHost);
    await act(async () => {
      rowRoot.render(
        h(MessageRow as never, {
          id: "row-a",
          from: "Andi Berger",
          subject: "subj",
          ...avatarOf(A as never),
          participants,
          threadCount: 2,
        } as never),
      );
    });

    const lead = faceOf(rowHost.querySelector(".row > .av"));
    const strip = [...rowHost.querySelectorAll(".thread-circles .av")].map(faceOf);
    expect(strip).toHaveLength(2);

    // One person, one face, both surfaces: letter AND hue agree exactly.
    expect(lead).toEqual(viewer.a);
    expect(strip[0]).toEqual(viewer.a);
    expect(strip[1]).toEqual(viewer.g);

    await act(async () => { rowRoot.unmount(); });
    rowHost.remove();
  });

  it("the derivation is deterministic — same input, same output, every time", async () => {
    const { avatarHue, initialsOf } = await import("../app/shell/format.js");
    // A per-render or per-session free variable (a random seed, a Date.now() salt) breaks
    // repeated calls apart; a pure function cannot.
    for (const address of [ANDI.address, BARE.address, "someone@else.example"]) {
      expect(avatarHue(address)).toBe(avatarHue(address));
    }
    expect(initialsOf("Andi Berger")).toBe("A");
    expect(initialsOf("mila@trafficflow.example")).toBe("M");
    expect(initialsOf(" andi@bergerweb.example")).toBe("A");
  });
});
