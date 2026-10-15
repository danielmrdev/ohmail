/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  mutationEffects,
  type EngineMessage,
  type Folder,
  type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import { withBodyDoor } from "./_body-door.js";

/**
 * THE SCREENER OPENS ON THE LATEST HELD MESSAGE — INCLUDING ON A WARM ACCOUNT.
 *
 * A sender waiting at the gate usually has more than one message. The held mail renders
 * OLDEST→NEWEST (`selectors.ts`: `held: [...newestFirst].reverse()`), so a fresh render sits at the
 * top on the OLDEST one and the reader takes their consent decision on the least current thing the
 * sender sent. `ScreenerView` fixes that by anchoring the LAST `.hmail` on selection.
 *
 * ── WHY "ON A WARM ACCOUNT" IS THE WHOLE POINT OF THIS FILE ──────────────────────────────────
 *
 * On the DEMO world every held message carries its body verbatim (`bodyOf`'s `m.body !== undefined`
 * branch), so the entries are their final height the first time the anchor runs and it lands
 * correctly. On a real Cloud account every held row is DERIVED: each body starts as a snippet and
 * arrives later through `hydrateBody`. The entries therefore GROW after the anchor has been
 * computed — and the anchor is a raw `scrollTop` in pixels, not an element reference, so growth
 * silently invalidates it. Three snippets at ~100px put the reader 186px down; the same three
 * messages hydrated are ~600px each, and 186px is now inside the FIRST message.
 *
 * That is invisible to every fixture-based test and to any check run against a cold mirror, which
 * is exactly the class of failure `CLAUDE.md` warns about: green against an empty dataset is worth
 * nothing.
 *
 * ── HOW THIS TEST SEES IT, GIVEN THAT jsdom HAS NO LAYOUT ────────────────────────────────────
 *
 * jsdom returns zeros from `getBoundingClientRect` and ignores `scrollTop` writes, so the anchor
 * arithmetic is unobservable by default and any assertion about it would be green by construction.
 * So layout is MODELLED, minimally and explicitly:
 *
 *  · `scrollTop` becomes a real read/write property backed by a `WeakMap`, so the assignment the
 *    component makes can be read back;
 *  · `getBoundingClientRect` on a `.hmail` reports `top = <its offset in the scroller> - scrollTop`,
 *    which is what a browser reports, and `0` for the scroller itself. The component computes
 *    `last.top - read.top + read.scrollTop`, so under this model it lands on the last entry's
 *    offset — the real semantics, not a stand-in for them;
 *  · an entry's height is SNIPPET_PX until its body is hydrated in the mirror and FULL_PX after,
 *    which is the growth the real account exhibits.
 *
 * The premise is asserted before the conclusion: the entries must actually have grown, or the
 * "re-anchored" assertion is about an input that never varied.
 */

// See the sync-liveness harness for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

/** A collapsed held entry — a snippet line and its chrome. */
const SNIPPET_PX = 100;
/** The same entry once its body has landed. The ratio is what makes the defect visible. */
const FULL_PX = 600;
/** The component's own breathing room above the anchored entry. */
const ANCHOR_SLACK = 14;

// ── the layout model ────────────────────────────────────────────────────────────────────────

const scrollTops = new WeakMap<Element, number>();

Object.defineProperty(Element.prototype, "scrollTop", {
  configurable: true,
  get(this: Element) { return scrollTops.get(this) ?? 0; },
  set(this: Element, v: number) { scrollTops.set(this, Math.max(0, v)); },
});

/** The ids `fetchBody` has answered for — the premise check, not the layout input. */
let hydrated = new Set<string>();

/**
 * The text `fetchBody` returns. An entry is tall when its OWN rendered text is the full body rather
 * than the snippet, read off the DOM: the height then follows from what is on screen instead of from
 * a flag the test also controls, so the model cannot claim a growth the component never rendered.
 */
const FULL_BODY_MARK = "the whole of";

function heightOf(el: Element): number {
  return (el.textContent ?? "").includes(FULL_BODY_MARK) ? FULL_PX : SNIPPET_PX;
}

Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element): DOMRect {
  const rect = (top: number, height: number): DOMRect =>
    ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

  const read = document.querySelector<HTMLElement>(".view-screener .scn-read");
  if (this === read) return rect(0, 800);
  if (!(this as HTMLElement).classList?.contains("hmail")) return rect(0, 0);

  // The entry's offset inside the scroller is the sum of the heights of its predecessors; a
  // browser reports that MINUS the scroller's current scrollTop, which is what makes the
  // component's `+ read.scrollTop` term correct rather than decorative.
  const entries = [...(read?.querySelectorAll<HTMLElement>(".hmail") ?? [])];
  let offset = 0;
  for (const e of entries) {
    if (e === this) break;
    offset += heightOf(e);
  }
  return rect(offset - (read ? read.scrollTop : 0), heightOf(this));
};

/** The offset the LAST entry sits at, under the model above. */
function offsetOfLast(): number {
  const read = document.querySelector<HTMLElement>(".view-screener .scn-read")!;
  const entries = [...read.querySelectorAll<HTMLElement>(".hmail")];
  let offset = 0;
  for (let i = 0; i < entries.length - 1; i++) offset += heightOf(entries[i]!);
  return offset;
}

const scrollerTop = (): number =>
  document.querySelector<HTMLElement>(".view-screener .scn-read")!.scrollTop;

// ── the world ───────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-08-10T12:00:00.000Z");
let seq = 0;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let bodyGate: (() => void) | null = null;

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

function msg(id: string, from: string, hour: number, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-08-10T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-10T09:00:00.000Z",
  };
}

/**
 * A DERIVED (warm-account) world: messages in the mirror, no `screener_sender` fixture rows, and
 * bodies that arrive only when `fetchBody` is allowed to resolve. That gate is what lets the test
 * observe the two moments — anchored on snippets, then bodies land — separately.
 */
async function engineWith(held: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    held.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  const open = new Promise<void>((resolve) => { bodyGate = resolve; });
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m) => {
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq,
            updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
          }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async (id: string) => {
        await open;
        hydrated.add(id);
        return {
          text: `${FULL_BODY_MARK} ${id}`, html: null, loadedRemoteContent: false,
          unsubscribe: "no_header" as const, unsubscribeUrl: null,
        };
      },
    },
  });
}

async function mount(engine: OhmailEngine): Promise<void> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, v, (() => {}) as never);
    const [sel, setSel] = React.useState<Record<string, string | null>>({
      waiting: null, screened: null, spam: null,
    });
    return h(ScreenerView, {
      owed: false,
      state,
      segment: "waiting", settled: true, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      // THE REAL hydration path, not a no-op: this test is about what happens when bodies land.
      hydrateBody: (id: string) => { void engine.hydrateBody(id); },
        hydrateBodies: (ids: string[], o?: { urgent?: boolean }) => { void engine.hydrateBodies(ids, o); },
      full: false, onFull: () => {},
    } as never);
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(ThemeProvider, {
          storageKey: null,
          children: withBodyDoor(engine, h(KeymapProvider, { children: h(Probe) })),
        }),
      }),
    );
  });
  await flush();
  await settleFirstPaint();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  hydrated = new Set();
  bodyGate = null;
  globalThis.fetch = (async () => json({})) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

/** One sender, three held messages — the ordinary multi-message shape at the gate. */
const THREE = () => [
  msg("oldest", "stranger@example.com", 8),
  msg("middle", "stranger@example.com", 10),
  msg("newest", "stranger@example.com", 12),
];

describe("the Screener opens on the sender's LATEST held message", () => {
  it("renders the held mail oldest→newest, so the anchor is load-bearing", async () => {
    // The premise. If `held` were newest-first the anchor would be unnecessary and every assertion
    // below would be about nothing.
    await mount(await engineWith(THREE()));
    const read = host!.querySelector<HTMLElement>(".view-screener .scn-read")!;
    const subjects = [...read.querySelectorAll(".hmail")]
      .map((e) => e.querySelector("h2")?.textContent ?? "");
    expect(subjects).toHaveLength(3);
    expect(subjects[0]).toContain("oldest");
    expect(subjects[2]).toContain("newest");
  });

  it("anchors the last entry while the bodies are still snippets", async () => {
    // The behaviour that already worked: on selection, with every entry at its collapsed height, the
    // scroller is put on the last one.
    await mount(await engineWith(THREE()));
    expect(offsetOfLast()).toBe(SNIPPET_PX * 2);
    expect(scrollerTop()).toBe(SNIPPET_PX * 2 - ANCHOR_SLACK);
  });

  it("STAYS on the last entry once the bodies land — the warm-account case", async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. A raw pixel anchor computed over collapsed entries is
    // wrong the moment they grow, and on a live account they always grow: every held body starts as
    // a snippet and arrives through `hydrateBody`. Nothing about this is visible on the demo world,
    // where bodies are present from the first render.
    await mount(await engineWith(THREE()));
    const beforeOffset = offsetOfLast();

    // Let the bodies arrive.
    bodyGate?.();
    await flush();

    // PREMISE FIRST: the entries really did grow. Without this the assertion below could pass
    // against a layout that never changed.
    const afterOffset = offsetOfLast();
    expect(hydrated.size, "no body was hydrated — the test never reached its own subject").toBe(3);
    expect(
      afterOffset,
      "the entries did not grow, so this test asserts invariance against an input that never varied",
    ).toBeGreaterThan(beforeOffset);

    expect(
      scrollerTop(),
      "the reader was left where the COLLAPSED entries put them, which is inside the oldest "
        + "message — the consent decision is taken on the least current thing the sender sent",
    ).toBe(afterOffset - ANCHOR_SLACK);
  });

  it("a single held message needs no anchoring and gets none", async () => {
    // The one-message case must not scroll at all: the entry is the whole content.
    await mount(await engineWith([msg("only", "solo@example.com", 9)]));
    expect(scrollerTop()).toBe(0);
    bodyGate?.();
    await flush();
    expect(scrollerTop()).toBe(0);
  });
});
