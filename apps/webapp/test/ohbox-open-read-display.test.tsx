/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * AN ARMED READ PRESENTS AS READ, AND IS SAVED AS READ (owner-reported presentation).
 * Arming — an explicit open, or the split pane's two-second dwell — drops the row's dot and weight,
 * flips the open message's verb to "Mark unread" and SAVES the read in the same moment, so the
 * counts agree with the row. The row keeps its PLACE under New until it is left (the session lease
 * and the slide's hold), and `u` re-bolds it in place and puts the verb back.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Comfortably past the slide, without reaching the 2 s dwell. */
const AFTER_SLIDE_MS = 400;

function setViewport(mobile = false): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: mobile, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

interface Row { id: string; unread: boolean; date?: string }

function msg(m: Row): Record<string, unknown> {
  return {
    id: m.id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subj-${m.id}`, from: { name: m.id, address: `${m.id}@ex.example` }, to: [], cc: [],
    date: m.date ?? "2026-08-02T09:00:00.000Z", folder: "INBOX", snippet: `snip-${m.id}`,
    unread: m.unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** The mirror. `onMarkSeen` writes it, the way the engine's optimistic overlay does. */
let live: Row[] = [];
let sel: string | null = null;
const marked: Array<{ ids: string[]; unread: boolean }> = [];
const armedLog: Array<string | null> = [];

async function draw(): Promise<void> {
  const { OhboxView } = await import("../app/views/OhboxView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
    children: h(KeymapProvider as never, { children: h(OhboxView as never, {
    owed: false,
      demo: false, settled: true,
      older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
      newForYou: live.filter((r) => r.unread).map(msg),
      previouslySeen: live.filter((r) => !r.unread).map(msg),
      tags: [], now: new Date("2026-08-02T09:00:00.000Z"),
      selectedId: sel,
      onSelect: (id: string) => { sel = id; },
      onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
      onMarkSeen: (ids: string[], unread: boolean) => {
        marked.push({ ids, unread });
        for (const id of ids) {
          const row = live.find((r) => r.id === id);
          if (row) row.unread = unread;
        }
      },
      onReadArmed: (id: string | null) => { armedLog.push(id); },
      bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
      doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
    } as never) } as never),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
}

async function mount(rows: Row[]): Promise<void> {
  live = rows.map((r) => ({ ...r }));
  sel = null;
  await draw();
}

function rowEl(id: string): HTMLElement {
  const el = host!.querySelector<HTMLElement>(`.row[data-id="${id}"]`);
  if (!el) throw new Error(`no row for ${id}`);
  return el;
}

function idsInGroup(label: string): string[] {
  const box = host!.querySelector(`[role="listbox"][aria-label="${label}"]`);
  if (!box) return [];
  return [...box.querySelectorAll(".row[data-id]")].map((r) => (r as HTMLElement).dataset.id!);
}

/** The read-state slot of the open message's action bar — "Mark read" or "Mark unread". */
function verb(): string {
  const b = host!.querySelector(".abar-read-g button.abar-read");
  if (!b) throw new Error("no read-state verb on screen — is a message open in the column?");
  return b.textContent ?? "";
}

async function click(id: string): Promise<void> {
  await act(async () => { rowEl(id).click(); });
  await draw();
}

async function press(key: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await draw();
}

async function settle(ms = AFTER_SLIDE_MS): Promise<void> {
  await draw();
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await draw();
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null; sel = null; live = [];
  marked.length = 0; armedLog.length = 0;
  vi.useRealTimers();
});

describe("the selection taken away from outside is a departure", () => {
  // The URL carries the open message now, so Back on `#/ohbox/m/A` clears the SHELL's
  // selection while this view stays mounted — a way of leaving that none of the four in-view
  // departures can see (a review finding). Two halves, matching `selectByUser`'s:
  it("Back inside the dwell window cancels the arm — nothing is ever written for A", async () => {
    vi.useFakeTimers();
    try {
      setViewport();
      await mount([{ id: "a", unread: true }, { id: "b", unread: true }]);
      await click("a"); // the cursor lands; the dwell arms
      await act(async () => { await vi.advanceTimersByTimeAsync(800); });
      // Back drops the id before the two seconds elapse: the shell's selection goes null.
      sel = null;
      await draw();
      // The dwell must NOT complete off-screen and must not be spent by a later act.
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      await click("b");
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(marked, "leaving before the dwell elapsed is not reading").toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the dwell saves the read at its end; Back after it writes nothing more", async () => {
    vi.useFakeTimers();
    try {
      setViewport();
      await mount([{ id: "a", unread: true }, { id: "b", unread: true }]);
      await click("a");
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); }); // armed and saved
      expect(marked).toEqual([{ ids: ["a"], unread: false }]);
      sel = null;
      await draw();
      expect(marked, "Back is a departure: it releases the place and writes nothing").toEqual([
        { ids: ["a"], unread: false },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("an armed read presents as read", () => {
  it("open: the verb offers Mark unread, the row unbolds IN PLACE, and the read is saved", async () => {
    /* THE HEADLINE PAIR, owner-reported, now with the write that makes it true: the
       bar offers "Mark unread", the row loses its ink, the count drops by the one saved read,
       and the row stays in its slot under New while it is open. */
    vi.useFakeTimers();
    setViewport();
    await mount([{ id: "a", unread: true, date: "2026-08-02T09:01:00.000Z" }, { id: "b", unread: true, date: "2026-08-02T09:00:00.000Z" }]);

    await click("a");          // select
    await click("a");          // open — the read is ARMED, not written
    expect(verb()).toContain("Mark unread");
    expect(verb()).not.toContain("Mark read");
    expect(rowEl("a").dataset.unseen, "the open message's row keeps unread ink").toBeUndefined();
    expect(rowEl("a").classList.contains("seen")).toBe(true);
    // …and IN PLACE: nothing moved, the read was written, and the count agrees with the row.
    expect(idsInGroup("New")).toEqual(["a", "b"]);
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
    expect(host!.textContent).toContain("1 unread");
  });

  it("the split pane's two-second dwell arms the same presentation", async () => {
    /* The dwell is the product's own "reading has happened" judgement, so it flips the same two
       surfaces the open does. One click only — the cursor rests, the clock runs. */
    vi.useFakeTimers();
    setViewport();
    await mount([{ id: "a", unread: true, date: "2026-08-02T09:01:00.000Z" }, { id: "b", unread: true, date: "2026-08-02T09:00:00.000Z" }]);

    await click("a");
    expect(rowEl("a").dataset.unseen, "a bare selection is not a reading").toBe("1");
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await draw();
    expect(rowEl("a").dataset.unseen).toBeUndefined();
    expect(verb()).toContain("Mark unread");
    expect(marked, "the dwell arms and saves").toEqual([{ ids: ["a"], unread: false }]);
    expect(idsInGroup("New")).toEqual(["a", "b"]);
  });

  it("`u` on the armed message re-bolds it in place and the verb offers Mark read again", async () => {
    /* The endorsed refinement: an explicit unread while it sits in New re-bolds it and it
       stays put. `u` already ends the hold and pins; the presentation must follow. */
    vi.useFakeTimers();
    setViewport();
    await mount([{ id: "a", unread: true, date: "2026-08-02T09:01:00.000Z" }, { id: "b", unread: true, date: "2026-08-02T09:00:00.000Z" }]);

    await click("a");
    await click("a");
    expect(rowEl("a").dataset.unseen).toBeUndefined();

    await press("u");
    expect(marked.at(-1)).toEqual({ ids: ["a"], unread: true });
    expect(rowEl("a").dataset.unseen).toBe("1");
    expect(verb()).toContain("Mark read");
    expect(idsInGroup("New")).toEqual(["a", "b"]);

    // …and the pin holds: nothing after `u` writes the message read again.
    const afterU = marked.length;
    await click("b");
    await settle();
    expect(marked.slice(afterU).filter((m) => m.ids.includes("a") && !m.unread)).toEqual([]);
    expect(idsInGroup("New")).toEqual(["a", "b"]);
  });

  it("the open writes exactly one read, leaving adds none, and the row then slides to Earlier", async () => {
    /* The round trip: the presentation and the WRITE both land at the open, and the move waits
       for the departure and stays the slide's. The display never disagrees with the account. */
    vi.useFakeTimers();
    setViewport();
    await mount([{ id: "a", unread: true, date: "2026-08-02T09:01:00.000Z" }, { id: "b", unread: true, date: "2026-08-02T09:00:00.000Z" }]);

    await click("a");
    await click("a");
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);

    await click("b");          // departure — the place is released, nothing is written
    expect(marked).toEqual([{ ids: ["a"], unread: false }]);
    await settle();
    expect(idsInGroup("New")).toEqual(["b"]);
    expect(idsInGroup("Earlier")).toEqual(["a"]);
  });

  it("the armed id is reported upward, and cleared on departure — the sheet's bar reads it", async () => {
    /* The mobile reader sheet is the SHELL's MessagePane (`AppShell`), not this view's column,
       so the armed fact travels up through `onReadArmed` and the shell presents the sheet's
       message with the same effective read-state. This pins the reporting contract the shell
       relies on: armed on open, cleared on departure or when `u` tears it up. */
    vi.useFakeTimers();
    setViewport();
    await mount([{ id: "a", unread: true, date: "2026-08-02T09:01:00.000Z" }, { id: "b", unread: true, date: "2026-08-02T09:00:00.000Z" }]);

    await click("a");
    await click("a");
    expect(armedLog.at(-1)).toBe("a");
    await press("u");
    expect(armedLog.at(-1)).toBeNull();

    await click("a");          // open again (still unread — the pin held it)
    expect(armedLog.at(-1)).toBe("a");
    await click("b");          // selecting b is the departure; the hold ends
    expect(armedLog.at(-1)).toBeNull();
  });
});
