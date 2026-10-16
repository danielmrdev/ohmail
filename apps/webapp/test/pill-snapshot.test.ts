/** @vitest-environment jsdom */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { setActiveFormatZone } from "../app/shell/locale";

/**
 * THE PILL SHIPS BYTE-IDENTICAL THROUGH THE VIEWER REDESIGN.
 *
 * The action bar (`ActionBar`, `MessagePane.tsx`) is OUT OF SCOPE for the thread-panel
 * redesign: the wrapper around it changed, the bar did not. This pins the rendered `.abar`
 * markup on a fixed fixture to the bytes captured BEFORE the slice
 * (`test/fixtures/abar-pill.html`), on both surfaces the pane renders — the single message
 * (through `ReadingPane`'s actions slot) and the thread (mounted once at the foot of the
 * scrolling wrapper). Any drift in the bar's own markup — a verb added, a class renamed, a
 * wrapper injected — goes red here and has to be a deliberate slice of its own, at which
 * point the fixture is re-captured WITH that slice.
 *
 * The fixture is a byte capture, not a hand-written expectation, so the assertion is
 * `toBe(fixture)` on `outerHTML` — nothing is normalised, because "byte-identical" is the
 * claim being made.
 *
 * ── RE-CAPTURED ONCE, FOR THE FORWARD VERB ────────────────────────────────────────────
 *
 * The capture now includes `<div class="abar-g abar-fwd">…Forward…</div>` between Reply and the
 * horizons. That is the slice this file's own rule describes: Forward was reachable only from a
 * message panel's ⋯ menu and is a row verb on the bar now (reported from real use — *"Forward in
 * general should be within our main pill-shaped UI besides Reply etc."*), with its rung derived in
 * `action-bar.css` and the row/menu complement asserted in `action-bar.test.ts`.
 *
 * The re-capture is the WHOLE diff against the previous bytes — one group inserted, nothing else
 * renamed, reordered or wrapped — which is what this guard is for: it made the change's blast
 * radius on the bar's markup readable in one line rather than argued.
 *
 * ── RE-CAPTURED AGAIN, FOR THE READ SWITCH'S NAME AND ITS LABEL SPAN ──────────────────
 *
 * The capture now has `aria-label="Mark unread"` on the read switch and its words inside a
 * `<span class="abar-read-lab">`. That is the WHOLE diff against the previous bytes — nothing
 * renamed, reordered or wrapped anywhere else in the pill — and it is the slice this file's own
 * rule describes.
 *
 * Both halves are one change. The pill fills its row and folds by measurement now, and when even
 * the floor does not fit (German `Als ungelesen markieren` in a 292px reading column) the floor
 * yields ITS WORDS: the span is what the stylesheet can hide, the dot and the keycap stay, and
 * the `aria-label` is what keeps the button named once its words are gone. The name is
 * unconditional rather than added only while compact, because a control whose accessible name
 * appears and disappears with a container width is worse than one that always has it.
 *
 * The `title` is NOT in this capture and that is correct: it is set only while the compact floor
 * is in force, and this mount is not measured (no `ResizeObserver` in jsdom), so the bar stands
 * at its full floor. `action-bar.test.ts` holds the standing-`title` rule from the other side.
 *
 * NO KEYCAPS in the capture, and that is unchanged: this mount stands under no keymap provider, so
 * every `<Key>` renders nothing (`useBinding` finds no registry). The bar's shipped keycaps —
 * Forward's `⇧F` among them — are asserted where the registry exists, in `keymap-census.test.tsx`.
 *
 * ── RE-CAPTURED AGAIN, FOR THE PER-VERB ADMISSION MARK ────────────────────────────────
 *
 * The capture now carries `abar-v abar-<verb>` on each admissible element — the Forward and Tag
 * groups, and each of the three horizons and two filing BUTTONS. That is the WHOLE diff against
 * the previous bytes: seven marks added, nothing renamed, reordered, wrapped or removed, and the
 * `role`/`aria-label` on the two segment wrappers untouched.
 *
 * The slice is the one this file's rule describes. The pill folded a whole GROUP at a time, so
 * the horizons went behind More as a block of three and filing as a block of two: a row with
 * room for Later and Park folded both of them along with Resurface, measured at 1440 in the
 * widest reading column the product has with 150px of the pill's own room standing empty.
 * `.abar-v` is what lets the measurement read each verb's width on its own; the tokens are what
 * the stylesheet switches. Everything the reader sees at a width that fitted before is
 * unchanged — 360 and 390 admit the same verbs they did.
 *
 * ── AND ONCE MORE, FOR FORWARD ON THE FLOOR (DESIGN-026 §2.1) ─────────────────────────
 *
 * Forward's group lost its `abar-v`: it is floor now, standing beside Reply at every width, so
 * the measurement counts it in the base and nothing folds it. That one token is the whole diff.
 * Then the two answer verbs gained their icon faces (the floor's concessions after the read
 * switch's words): each button carries an `aria-label`, a hidden `abar-ico` and its word in an
 * `abar-<verb>-lab` span, and Reply the `abar-reply` hook. Nothing else moved.
 */

/* RE-CAPTURED FOR THE SCREENING BUTTON'S POPUP STATE: `aria-haspopup="dialog"` and a
   live `aria-expanded` on `.abar-screen` are the whole diff against the previous bytes. */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-02T12:00:00.000Z");

function msg(id: string, date: string, threadId: string | null): Record<string, unknown> {
  return {
    id, accountId: "a", mailboxId: "mb", threadId, messageIdHeader: null,
    subject: id === "a" ? "Quote for the north elevation" : "Re: Quote for the north elevation",
    from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
    to: [], cc: [], date, folder: "INBOX", snippet: `snippet-${id}`,
    unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}
const A = msg("a", "2026-07-30T09:00:00.000Z", "t1");
const B = msg("b", "2026-07-31T09:00:00.000Z", "t1");
const C = msg("c", "2026-08-01T09:00:00.000Z", "t1");
const SOLO = msg("solo", "2026-08-01T09:00:00.000Z", null);

/** The pre-slice capture. Two candidate roots for the same reason `conversation.test.ts` has them. */
function fixture(): string {
  const REL = "test/fixtures/abar-pill.html";
  const path = [resolve(process.cwd(), REL), resolve(process.cwd(), "apps/webapp", REL)].find(existsSync);
  expect(path, `could not find ${REL} from ${process.cwd()}`).toBeTruthy();
  return readFileSync(path!, "utf8");
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function mountPane(open: Record<string, unknown>, conversation: Array<Record<string, unknown>>): Promise<void> {
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
              text: m.snippet as string, state: "full", html: null,
              loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
            }),
            hydrateBody: () => {},
            hydrateThread: () => {},
          },
          children: h(MessagePane as never, {
            message: open, tags: [], now: NOW,
            onAction: () => {}, onAddTag: () => {}, onAttachment: () => {},
          } as never),
        } as never),
      }),
    );
  });
}

beforeEach(() => {
  setActiveFormatZone("UTC");
});

afterEach(async () => {
  await unmount();
  setActiveFormatZone(null);
});

describe("the action pill is byte-identical to its pre-redesign capture", () => {
  it("on the single-message surface", async () => {
    await mountPane(SOLO, []);
    const bar = host!.querySelector(".msg-actions .abar");
    expect(bar, "no pill in the single message's actions slot").toBeTruthy();
    expect(bar!.outerHTML).toBe(fixture());
  });

  it("on the thread surface — one pill, same bytes", async () => {
    await mountPane(B, [A, B, C]);
    const bars = host!.querySelectorAll(".msg-actions .abar");
    expect(bars).toHaveLength(1);
    expect(bars[0]!.outerHTML).toBe(fixture());
  });
});
