/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  bodyOf,
  type EngineMessage,
  type MessageBodyWire,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { BODY_STALL_MS, type BodyTarget } from "../app/shell/message-chrome.js";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE HELD PREVIEW DRAWS ITS BODY THROUGH THE READER'S DOOR.
 *
 * Mounted in the shell's shape: the queue keyed on the DERIVED stamp, which a body write does not
 * move, the engine provided, the chrome's `bodyOf` the door. The earlier held tests keyed the queue
 * on a version every notify moved — a state the shell never has — and read green over a preview
 * that never drew a body it had read. With no other row write, only the door can draw it.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const NOW = new Date("2026-09-25T08:00:00.000Z");
let seq = 0;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function held(id: string, hour: number, unread = true): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: "A Stranger", address: "stranger@example.test" },
    to: [], cc: [], date: `2026-09-25T${String(hour).padStart(2, "0")}:00:00.000Z`, folder: "ohmail/Screener",
    snippet: `one line of ${id}`, unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

const answer = (id: string): MessageBodyWire => ({
  text: `the whole of ${id}`, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
});

async function engineWith(seed: EngineMessage[], fetchBody: (id: string) => Promise<MessageBodyWire>) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(seed.map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  const asked: string[] = [];
  const engine = new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: (id: string) => { asked.push(id); return fetchBody(id); },
    },
  });
  return { engine, asked };
}

async function mount(engine: OhmailEngine): Promise<void> {
  const { EngineProvider, useDerivedVersion } = await import("../app/shell/engine.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  /* `AppShell`'s door, as it resolves a target: the mirror's own row, else a resting snippet. */
  const door = (m: BodyTarget) => bodyOf(engine.read(), engine.read().get<EngineMessage>("message", m.id) ?? m);
  function Probe(): React.ReactElement {
    const version = useDerivedVersion();
    const state = useScreenerState(engine, version, (() => {}) as never);
    const [sel, setSel] = React.useState<Record<string, string | null>>({ waiting: null, screened: null, spam: null });
    return h(ScreenerView, {
      owed: false, state, segment: "waiting", settled: true, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      hydrateBody: (id: string, opts?: { retry?: boolean; urgent?: boolean }) => { void engine.hydrateBody(id, opts); },
      hydrateBodies: (ids: string[], o?: { urgent?: boolean }) => { void engine.hydrateBodies(ids, o); },
      full: false, onFull: () => {},
    } as never);
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(EngineProvider as never, {
        demo: false, engine,
        children: h(MessageChromeProvider as never, {
          value: { bodyOf: door, hydrateBody: () => {}, hydrateBodies: () => {}, hydrateThread: () => {}, conversationOf: () => [] },
          children: h(KeymapProvider, { children: h(Probe) }),
        }),
      }),
    }));
  });
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
  await settleFirstPaint();
}

const articles = (): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>(".scn-mails .hmail")];
const bodyText = (el: HTMLElement): string => el.querySelector(".hm-body")?.textContent ?? "";
const noteOf = (el: HTMLElement): string => el.querySelector(".hm-state")?.textContent ?? "";

beforeEach(() => {
  (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: false, media: q, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  });
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("a held body that was read is drawn, with nothing else moving", () => {
  it("the landed body reaches the preview, and no stall face follows it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { engine, asked } = await engineWith([held("h1", 6), held("h2", 7)], async (id) => answer(id));
    await mount(engine);
    await act(async () => { await vi.advanceTimersByTimeAsync(BODY_STALL_MS + 1_000); });
    expect(asked.sort(), "premise: the selection read both held bodies").toEqual(["h1", "h2"]);
    const [a, b] = articles();
    expect(bodyText(a!)).toContain("the whole of h1");
    expect(bodyText(b!)).toContain("the whole of h2");
    expect(noteOf(a!) + noteOf(b!)).not.toContain("Couldn't load");
  });
});

describe("Retry is a new attempt, and the preview shows that attempt", () => {
  it("after a failed read, Retry asks again, reads as loading, then draws the text", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release!: () => void;
    const late = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const { engine, asked } = await engineWith([held("h1", 6)], async (id) => {
      calls += 1;
      if (calls === 1) throw new Error("the mail engine answered 500");
      await late;
      return answer(id);
    });
    await mount(engine);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const [only] = articles();
    expect(noteOf(only!), "premise: the first read failed").toContain("Couldn't load");
    await act(async () => { only!.querySelector<HTMLButtonElement>(".hm-state button")!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(asked, "Retry made no new attempt").toEqual(["h1", "h1"]);
    expect(noteOf(articles()[0]!)).toContain("Loading the full message");
    release();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(bodyText(articles()[0]!)).toContain("the whole of h1");
    expect(articles()[0]!.querySelector(".hm-state")).toBeNull();
  });

  it("a Retry that fails too says so, with its own Retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { engine, asked } = await engineWith([held("h1", 6)], async () => {
      throw new Error("the mail engine answered 500");
    });
    await mount(engine);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { articles()[0]!.querySelector<HTMLButtonElement>(".hm-state button")!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(asked).toEqual(["h1", "h1"]);
    expect(noteOf(articles()[0]!)).toContain("Couldn't load");
    expect(articles()[0]!.querySelector(".hm-state button"), "the second failure lost its control").not.toBeNull();
  });
});

describe("the waiting row says whether its held mail was read", () => {
  const rowDesc = (): string =>
    host!.querySelector<HTMLElement>(".view-screener [aria-description]")?.getAttribute("aria-description") ?? "";

  it("unread held mail is spoken Unread; read held mail is spoken Read", async () => {
    const { engine } = await engineWith([held("h1", 6)], async (id) => answer(id));
    await mount(engine);
    expect(rowDesc()).toMatch(/\bUnread\b/);
    await act(async () => { root!.unmount(); });
    host!.remove();
    const { engine: readEngine } = await engineWith([held("r1", 6, false)], async (id) => answer(id));
    await mount(readEngine);
    expect(rowDesc()).toMatch(/\bRead\b/);
    expect(rowDesc()).not.toMatch(/\bUnread\b/);
  });
});

/**
 * THE ONE DOOR, CENSUSED. The reader and the held preview draw through `useDrawnBody`, the shell
 * hands the chrome ONE `bodyOf`, and no view draws a body another way — the shape that let the
 * preview draw the queue's copy while the reader drew the record.
 */
describe("the held preview and the reader call one door", () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  it("MessagePane, MessageCard and HeldMail each draw through useDrawnBody, and only it", () => {
    for (const rel of ["../app/shell/MessagePane.tsx", "../app/shell/MessageCard.tsx", "../app/views/ScreenerView.tsx"]) {
      const src = read(rel);
      expect(src, `${rel} does not draw through the one door`).toMatch(/useDrawnBody\s*\(/);
      expect(src, `${rel} draws a body past the door`).not.toMatch(/(?:^|[^\w.])bodyOf\s*\(|\.bodyOf\s*\(/m);
    }
    const view = read("../app/views/ScreenerView.tsx");
    const heldMail = view.slice(view.indexOf("export function HeldMail("), view.indexOf("function ReaderNote("));
    expect(heldMail, "HeldMail lost its door").toMatch(/useDrawnBody\s*\(\s*message/);
  });
  it("the shell hands the chrome the one function every drawn body reads", () => {
    const shell = read("../app/shell/AppShell.tsx");
    expect(shell).toMatch(/bodyOf:\s*bodyOfMessage\b/);
    expect(shell.match(/const bodyOfMessage\s*=/g), "a second body door was declared").toHaveLength(1);
  });
});
