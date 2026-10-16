/** @vitest-environment jsdom */
/**
 * WHAT ONE PUBLISH COSTS THE WINDOW — counted, per component and per whole-mirror pass.
 *
 * The renderer-peak rig reads the MAGNITUDE (megabytes of resident peak per shell re-render,
 * independent of the row count, on a real WebKit web process). It cannot say WHICH components
 * ran or WHY. This file is the other half: the real `AppShell` over an engine whose publishes
 * are scripted one at a time, with every view and pane wrapped in a counter, so a publish's cost
 * is a number rather than an impression.
 *
 * THE INSTRUMENT IS EXACT, NOT A HEURISTIC. React's own profiler answers "did this subtree do
 * work" by timing, and a fiber that was never visited keeps its previous commit's duration —
 * which reads as work on a quiet subtree. So the count here is of FUNCTION-BODY INVOCATIONS:
 * each component is replaced by a wrapper that increments a counter and renders the real one.
 * `SyncBar` is the shell's own counter — `ShellInner` renders it unconditionally and nothing
 * memoizes it, so its count IS the whole-window re-render count.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

const renders = new Map<string, number>();
const bump = (name: string): void => { renders.set(name, (renders.get(name) ?? 0) + 1); };
export const countOf = (name: string): number => renders.get(name) ?? 0;

/** Wrap one component export in a body-invocation counter, preserving everything it does. */
function counted<P>(name: string, Real: React.ComponentType<P>): React.ComponentType<P> {
  const Wrapped = (props: P): React.ReactElement => {
    bump(name);
    return React.createElement(Real as React.ComponentType<object>, props as object);
  };
  Wrapped.displayName = `counted(${name})`;
  return Wrapped as React.ComponentType<P>;
}

vi.mock("../app/shell/SyncBar", async (orig) => {
  const actual = await orig<typeof import("../app/shell/SyncBar")>();
  return { ...actual, SyncBar: counted("SyncBar", actual.SyncBar) };
});
vi.mock("../app/views/OhboxView", async (orig) => {
  const actual = await orig<typeof import("../app/views/OhboxView")>();
  return { ...actual, OhboxView: counted("OhboxView", actual.OhboxView) };
});
vi.mock("../app/shell/MessagePane", async (orig) => {
  const actual = await orig<typeof import("../app/shell/MessagePane")>();
  return { ...actual, MessagePane: counted("MessagePane", actual.MessagePane) };
});
vi.mock("../app/shell/FoldersRailGroup", async (orig) => {
  const actual = await orig<typeof import("../app/shell/FoldersRailGroup")>();
  return { ...actual, FoldersRailGroup: counted("FoldersRailGroup", actual.FoldersRailGroup) };
});
vi.mock("../app/views/ComposeView", async (orig) => {
  const actual = await orig<typeof import("../app/views/ComposeView")>();
  return { ...actual, ComposeView: counted("ComposeView", actual.ComposeView) };
});
/* THE CHIP FIELD ITSELF, and not only the view above it. A loop in this component's own state
   re-renders THIS subtree and nothing higher, so a counter on `ComposeView` cannot see it —
   measured: the loop ran the file past five minutes while the view's count sat at its ordinary
   number. The instrument has to sit where the state does. */
vi.mock("../app/shell/RecipientField", async (orig) => {
  const actual = await orig<typeof import("../app/shell/RecipientField")>();
  return { ...actual, RecipientField: counted("RecipientField", actual.RecipientField) };
});

import {
  ISO, act, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";

import { MemoryMirrorStore, OhmailEngine, type EntityReader } from "@ohmail/client-engine";

/** Every whole-mirror pass a render made, by type — the derivation counter. */
const scans: string[] = [];

/**
 * WHO MADE THE PASS, with `OHMAIL_SCAN_STACKS=1`. Off by default because it is noise, kept
 * because it is how the three whole-mirror reads that ran on EVERY render — regardless of any
 * version — were found: the compose fallback's sending mailbox (which sorts the entire mailbox),
 * the shared date order behind it, and the durable outbox's pending-lane read. A count says a
 * pass happened; only a stack says who asked for it.
 */
const stacks: string[] = [];
const noteCaller = (what: string): void => {
  if (!process.env.OHMAIL_SCAN_STACKS) return;
  stacks.push(`${what}\n${(new Error().stack ?? "").split("\n").slice(1, 7).join("\n")}`);
};
export const callersSeen = (): string[] => stacks;

/**
 * The reader the shell reads through, wrapped once per underlying object so the memo identities
 * the shell keys on are untouched. `list`/`entries` on a mail type IS the whole-mirror pass the
 * store's own bucket cache rebuilds per version, so counting the calls counts the derivations.
 *
 * It forwards the STAMPS, and that is not boilerplate: a wrapper that dropped them would hand
 * the shell a stamp that never moves, and the window would hold a projection of a mirror that had
 * changed. This one dropped them while it was being written and the mount died on the spot —
 * which is the loud version of the failure `derived-stamp-census.test.ts` exists to catch quietly.
 */
const wrapped = new WeakMap<object, EntityReader>();
function counting(real: EntityReader): EntityReader {
  const had = wrapped.get(real as object);
  if (had) return had;
  const proxy: EntityReader = {
    get: (t, i) => real.get(t, i),
    list: (t) => { scans.push(`list:${t}`); noteCaller(`list:${t}`); return real.list(t); },
    entries: (t) => { scans.push(`entries:${t}`); noteCaller(`entries:${t}`); return real.entries(t); },
    version: () => real.version(),
    stampOf: (t) => real.stampOf(t),
    stampExcept: (i) => real.stampExcept(i),
  } as EntityReader;
  wrapped.set(real as object, proxy);
  return proxy;
}

let seqNo = 0;
const ISO_NOW = "2026-08-04T09:00:00.000Z";

/** One `/sync` page of `n` fresh messages plus a consent rule for each sender. */
function messagePage(n: number): { changes: unknown; cursor: string; hasMore: boolean; serverTime: string } {
  const creates: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const id = `mm${++seqNo}`;
    creates.push({
      type: "message", op: "create", id, seq: seqNo, updatedAt: ISO_NOW,
      entity: {
        id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
        subject: `subject of ${id}`,
        from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
        to: [], cc: [], date: ISO_NOW, folder: "INBOX", snippet: `snippet of ${id}`,
        unread: true, hasAttachments: false, attachmentCount: 0, sensitivity: {},
        triage: null, labels: [], remoteContent: "none", updatedAt: ISO_NOW,
      },
    });
    creates.push({
      type: "rule", op: "create", id: `rule_${id}`, seq: ++seqNo, updatedAt: ISO_NOW,
      entity: {
        id: `rule_${id}`, kind: "sender", match: `${id}@example.invalid`, destination: "INBOX",
        priority: 0, provenance: "seeded-from-sent", enabled: true,
        stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO_NOW, updatedAt: ISO_NOW,
      },
    });
  }
  return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: `c${seqNo}`, hasMore: false, serverTime: ISO_NOW };
}

/** The engine the shell is handed, with a feed the test pushes one page at a time into. */
async function buildEngine(): Promise<{ engine: OhmailEngine; store: MemoryMirrorStore; feed: unknown[] }> {
  const store = new MemoryMirrorStore();
  const feed: unknown[] = [];
  const adapter = {
    sync: async () => feed.shift() ?? { changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: `c${seqNo}`, hasMore: false, serverTime: ISO_NOW },
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async (id: string) => ({ text: `body of ${id}`, html: null, loadedRemoteContent: false }),
    fetchBodies: async (ids: string[]) => ids.map((id) => ({ messageId: id, text: `body of ${id}`, html: null, loadedRemoteContent: false })),
    /* THE ATTACHMENT CAPABILITY, present on purpose. `attachmentsAvailable()` reads these two off
       the adapter, and it gates the shell's attachment notice — an adapter without them would
       switch that subscription off for every arm below and measure a window the product is not. */
    listAttachments: async (id: string) => [
      { id: `${id}-a1`, filename: "note.txt", mimeType: "text/plain", sizeBytes: 12, inline: false },
    ],
    fetchAttachment: async () => ({ blob: new Blob([]), name: "x", mime: "text/plain" }),
  };
  const engine = new OhmailEngine({ adapter: adapter as never, store, eagerBodies: false });
  const realRead = engine.read.bind(engine);
  (engine as unknown as { read: () => EntityReader }).read = () => counting(realRead());
  await engine.start();
  return { engine, store, feed };
}


/**
 * THE CONSTANT — what a publish costs the window whatever it carried.
 *
 * Not zero, and it should not be: `useFreshness` publishes the mirror's "as of" stamp, which a
 * completed drain genuinely moves, and the shell draws it. Two renders per drain is that label
 * and nothing else; a body publish moves no stamp and is expected to cost none at all.
 */
const PUBLISH_CONSTANT = 2;

/** The components a body landing may not redraw. Each is a whole subtree of the window. */
const UNRELATED_TO_A_BODY = ["SyncBar", "OhboxView", "FoldersRailGroup"] as const;

describe("what one publish costs the window", () => {
  beforeEach(() => { renders.clear(); scans.length = 0; installShellEnv(); });
  afterEach(teardownShellEnv);

  it("a body publish redraws nothing unrelated and re-derives nothing at all", async () => {
    const { engine, feed } = await buildEngine();
    await mountShell([mailbox({ lastSyncAt: ISO })], { engine });
    await tick(100);
    feed.push(messagePage(200));
    await act(async () => { await engine.syncOnce(); });
    await tick(50);

    const firstId = engine.read().list<{ id: string }>("message")[0]?.id ?? "";
    expect(firstId, "the page did not land, so nothing below measures anything").not.toBe("");
    renders.clear(); scans.length = 0;

    await act(async () => { await engine.hydrateBody(firstId); });
    await tick(50);

    /*
     * A BODY IS A FACT ABOUT ONE MESSAGE. It is not a pile, a count, a partition or a projection,
     * and before the split every one of those was rebuilt for it — twenty whole-mirror passes,
     * against twenty-three for a full `/sync` page of messages.
     */
    expect(scans, `a body publish re-derived over the whole mirror: ${scans.join(", ")}`)
      .toHaveLength(0);
    for (const name of UNRELATED_TO_A_BODY) {
      expect(countOf(name), `${name} re-rendered for a body it does not draw`).toBe(0);
    }
  });

  /**
   * THE OTHER HALF, and without it the guard above is satisfied by a window that never draws a
   * body at all — which is precisely the failure this split could cause and the shape that
   * renders as its own healthy state. The text has to arrive on screen.
   */
  it("…and the body still arrives on the surface that opened it", async () => {
    const { engine, feed } = await buildEngine();
    const el = await mountShell([mailbox({ lastSyncAt: ISO })], { engine });
    await tick(100);
    feed.push(messagePage(12));
    await act(async () => { await engine.syncOnce(); });
    await tick(50);

    const openId = engine.read().list<{ id: string }>("message")[0]?.id ?? "";
    await act(async () => {
      window.location.hash = `#/ohbox/m/${openId}`;
      window.dispatchEvent(new Event("hashchange"));
    });
    await tick(600);

    expect(el.textContent ?? "", "the reading surface never showed the fetched body")
      .toContain(`body of ${openId}`);
  });

  /**
   * AN OPEN COSTS THE STATES IT SHOWS. The engine publishes three times for the body alone — the
   * loading marker, the answer, and the body-cache trim once the cache is full — and the
   * attachment list is a second pair on top. Every one of those used to redraw the whole window
   * and every pane in it.
   *
   * The ceiling is the states the pane actually has something new to draw for: it mounts, the
   * body lands, the attachment list settles, and the strip's items settle. The trim draws
   * nothing and no longer costs anything. The ceiling is a CEILING and not the count of the day:
   * it is here so the number cannot climb back unnoticed.
   */
  const OPEN_PANE_RENDERS = 4;

  it("an open costs the reading pane the states it shows and no more", async () => {
    const { engine, feed } = await buildEngine();
    await mountShell([mailbox({ lastSyncAt: ISO })], { engine });
    await tick(100);
    feed.push(messagePage(12));
    await act(async () => { await engine.syncOnce(); });
    await tick(50);
    const openId = engine.read().list<{ id: string }>("message")[0]?.id ?? "";
    renders.clear(); scans.length = 0;

    await act(async () => {
      window.location.hash = `#/ohbox/m/${openId}`;
      window.dispatchEvent(new Event("hashchange"));
    });
    await tick(600);

    expect(countOf("MessagePane"), "the reading pane drew more than the states it has")
      .toBeLessThanOrEqual(OPEN_PANE_RENDERS);
  });

  /**
   * THE NARROWING'S POSITIVE CONTROL — the case it still admits, measured.
   *
   * The attachment notice was narrowed twice: to "while there is a selection" and then to "while
   * the state this hook can SHOW has moved". Both are refusals, and a refusal rule that nobody
   * has watched admit the ordinary case is a rule that might refuse everything. Attachment bytes
   * arrive without touching the mirror — no version, no stamp, nothing — so this is the one
   * signal the window has, and it must still get through.
   */
  it("…and an attachment landing still reaches the window", async () => {
    const { engine, feed } = await buildEngine();
    expect(engine.attachmentsAvailable(), "the harness lost the capability the gate reads")
      .toBe(true);
    await mountShell([mailbox({ lastSyncAt: ISO })], { engine });
    await tick(100);
    feed.push(messagePage(12));
    await act(async () => { await engine.syncOnce(); });
    await tick(50);
    const openId = engine.read().list<{ id: string }>("message")[0]?.id ?? "";
    await act(async () => {
      window.location.hash = `#/ohbox/m/${openId}`;
      window.dispatchEvent(new Event("hashchange"));
    });
    await tick(600);
    renders.clear(); scans.length = 0;

    // The bytes of the one attachment this message has — the engine's own path, no mirror write.
    await act(async () => { await engine.openAttachment(openId, `${openId}-a1`); });
    await tick(50);

    expect(countOf("SyncBar"), "an attachment landing never reached the window")
      .toBeGreaterThan(0);
    // …and it is a re-render, never a re-derivation: no record moved.
    expect(scans, `it re-derived the mirror as well: ${scans.join(", ")}`).toHaveLength(0);
  });

  /**
   * A PAGE OF MAIL IS THE CASE THAT MUST STILL COST SOMETHING — the guards above are all "does
   * not happen", and a shell that stopped re-rendering altogether would pass every one of them.
   */
  it("a page of mail still redraws the list and re-derives the piles", async () => {
    const { engine, feed } = await buildEngine();
    await mountShell([mailbox({ lastSyncAt: ISO })], { engine });
    await tick(100);
    renders.clear(); scans.length = 0;

    feed.push(messagePage(200));
    await act(async () => { await engine.syncOnce(); });
    await tick(50);

    expect(countOf("OhboxView"), "an arriving page did not redraw the list").toBeGreaterThan(0);
    expect(scans.filter((s) => s === "list:message").length,
      "an arriving page did not re-derive over the messages").toBeGreaterThan(0);
    // …and the redraw is a constant, not a function of the page: a page of rows arriving is
    // one list to redraw, not a shell per row.
    expect(countOf("SyncBar"), "the window redrew per row rather than per publish")
      .toBeLessThanOrEqual(PUBLISH_CONSTANT * 4);
  });

  /**
   * AN IDLE POLL — an empty `/sync` page every eight seconds, for as long as a tab is open. It
   * moves the drain stamp, which the sync line draws, and nothing else.
   */
  it("an idle poll re-derives nothing", async () => {
    const { engine } = await buildEngine();
    await mountShell([mailbox({ lastSyncAt: ISO })], { engine });
    await tick(100);
    /* THE SECOND POLL, not the first. A cold mirror's first drain settles the sync status —
       `bootstrapping` falls, and several surfaces say so — which is a one-time transition and not
       what "every eight seconds for as long as the tab is open" costs. Measuring the first would
       pin that transition into this budget and go red the day it is made cheaper. */
    await act(async () => { await engine.syncOnce(); });
    await tick(50);
    renders.clear(); scans.length = 0;

    await act(async () => { await engine.syncOnce(); });
    await tick(50);

    expect(scans, `an empty page re-derived: ${scans.join(", ")}`).toHaveLength(0);
    expect(countOf("SyncBar"), "an empty page cost more than the freshness label")
      .toBeLessThanOrEqual(PUBLISH_CONSTANT);
  });
});

/**
 * ═══ A MIRROR DELTA LANDING ON AN OPEN COMPOSER ═══════════════════════════════════════
 *
 * The 0.20.0 review caught ONE production `Minified React error #185` (maximum update depth)
 * during its compose cell and could not reproduce it in three replays. The standing hypothesis
 * was a live sync delta racing the composer's recipient-chip state: the address book is DERIVED
 * FROM THE MIRROR, so every arriving message rebuilds `RecipientField`'s `suggestions` memo,
 * its `labels` memo behind that, and re-runs the one effect in the composer's chip path that
 * sets state from a value it also depends on —
 *
 *     useEffect(() => { if (cursor >= suggestions.length) setCursor(0); },
 *              [suggestions.length, cursor]);
 *
 * which is the shape that ping-pongs when the guard does not hold. This drives exactly that: a
 * composer open with a live tail in To, a cursor moved off zero, and fifty pages of mail landing
 * underneath it, each one adding a sender the tail matches.
 *
 * WHAT THIS CATCHES, AND WHAT IT DOES NOT — both measured, because a guard described by its
 * intention is a guard nobody has watched.
 *
 *  · IT CATCHES the cheap version: a derived value turned into state written from an effect.
 *    Driven twice into `RecipientField` (`live` and the label count) it costs two extra renders
 *    per publish and this case goes red by name. That is how this defect usually arrives.
 *  · IT DOES NOT convert a true update LOOP into a named red. Driven — the labels memo dropped
 *    so the derived array is fresh per render, plus state mirroring it with the array in deps —
 *    the file ran past four minutes and was killed by the timeout, with no assertion reached. A
 *    counter tripwire was tried and did not fire either: the throw lands inside the shell's own
 *    view boundary. So a loop here reads as a SUITE TIMEOUT, which is red but names nothing, and
 *    the production `#185` the 0.20.0 review saw once is NOT REPRODUCED by this file.
 *
 * The standing answer to the loud version is the route-level boundary (`app/(product)/error.tsx`,
 * landed before this): a render throw in the shell now renders a sentence and a reload rather
 * than Next's blank "Application error", which is the half of that change that was actually missing.
 */
describe("fifty deltas under an open composer", () => {
  beforeEach(() => { renders.clear(); scans.length = 0; installShellEnv(); });
  afterEach(teardownShellEnv);

  /**
   * Per publish: the composer redraws for the book behind its suggestions, and no more. MEASURED
   * at 2 — `PUBLISH_CONSTANT`, the same cost every other surface pays for a publish — with the
   * ceiling one above it so a regression to three is red rather than absorbed.
   */
  const COMPOSE_RENDERS_PER_PUBLISH = 3;
  const DELTAS = 50;

  it("the composer survives fifty publishes with a live recipient tail and a moved cursor", async () => {
    const { engine, feed } = await buildEngine();
    const el = await mountShell([mailbox({ lastSyncAt: ISO })], { engine });
    await tick(100);
    feed.push(messagePage(20));
    await act(async () => { await engine.syncOnce(); });
    await tick(50);

    await act(async () => {
      window.location.hash = "#/compose";
      window.dispatchEvent(new Event("hashchange"));
    });
    await tick(300);

    const to = el.querySelector<HTMLInputElement>("#compose-to");
    expect(to, "the composer never rendered its To field, so nothing below measures anything")
      .not.toBeNull();

    /* A TAIL THAT MATCHES EVERY ARRIVING SENDER (`mm<n>@example.invalid`), so the suggestion
       list genuinely moves under the open list on every publish. */
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value",
      )!.set!;
      setter.call(to!, "mm");
      to!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick(50);

    /* CURSOR OFF ZERO is the precondition: at zero the guard's `setCursor(0)` is a no-op write
       React bails out of, and the case would pass for a reason that has nothing to do with the
       rule under test. */
    for (const key of ["ArrowDown", "ArrowDown"]) {
      await act(async () => {
        to!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    }
    await tick(50);
    renders.clear(); scans.length = 0;

    for (let i = 0; i < DELTAS; i++) {
      feed.push(messagePage(1));
      await act(async () => { await engine.syncOnce(); });
    }
    await tick(200);

    // It genuinely ran: a case where no publish reached the composer would satisfy any ceiling.
    expect(countOf("ComposeView"), "no publish reached the open composer").toBeGreaterThan(0);
    expect(countOf("RecipientField"), "no publish reached the chip field").toBeGreaterThan(0);
    for (const name of ["ComposeView", "RecipientField"] as const) {
      expect(
        countOf(name),
        `${name} redrew ${countOf(name)} times for ${DELTAS} publishes`,
      ).toBeLessThanOrEqual(DELTAS * COMPOSE_RENDERS_PER_PUBLISH);
    }
    // And the form is still on screen — a composer that unmounted under the deltas would be a
    // worse failure than a loud one, and it would pass the ceiling.
    expect(el.querySelector("#compose-to"), "the composer left the screen").not.toBeNull();
  });
});
