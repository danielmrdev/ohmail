/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  LAST_DRAIN_AT_META,
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type MutationOutcome,
  type SyncResponse,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";

/**
 * ═══ FRAME ONE IS LOCAL, LABELED, AND NEVER WAITS FOR THE NETWORK — the census walk ══════════
 *
 * The Freshness Contract's whole-shell claim (INSTANT-ARCH §6.6, stage 2's acceptance): a
 * mirror stale by DAYS shows CONTENT in its first committed paint — the mail already on the
 * device — with the "As of <time> · catching up" label beside it, while the network has
 * answered NOTHING; and the label clears in the same pass the drain settles, never later.
 *
 * Driven through the REAL seams — `EngineProvider` (the desktop's provided-engine door, ready
 * from the first render), the real scheduler it starts, `useFreshness`, the provider, the
 * ladder and the strip — with only the wire faked: `/sync` is a gate this file holds shut.
 * A version of this that mocked the provider could not fail for a wiring bug, and the wiring
 * is where a frame-one property dies (`warm-open.test.tsx` records the same lesson for the
 * mailbox paint).
 *
 * Watched RED, then restored:
 *  · frame-one-awaits-network — asserting before the gate opens, with the stale arm deleted
 *    from the ladder: content still painted (the mirror's own property) but the label was
 *    gone, which is stale-shown-as-current on the live shell.
 *  · label-stuck-after-current — with the engine's settle-notify removed, the post-settle
 *    assertion kept finding the label: the strip only repaints on a notify, and the last one
 *    fired before the stamp landed.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const NOW = new Date("2026-08-29T12:00:00.000Z");
const STALE_STAMP = new Date(NOW.getTime() - 3 * 24 * 60 * 60_000).toISOString();
const ISO = STALE_STAMP;

const seedMessage = {
  type: "message" as const,
  op: "create" as const,
  id: "m-warm-1",
  seq: 100,
  updatedAt: ISO,
  entity: {
    id: "m-warm-1",
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: "the mail already on this device",
    from: { name: null, address: "sender@example.test" },
    to: [],
    cc: [],
    date: ISO,
    folder: "INBOX",
    snippet: "snippet",
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {},
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: ISO,
  },
};

const EMPTY_PAGE = (since: string): SyncResponse => ({
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: since,
  hasMore: false,
  serverTime: NOW.toISOString(),
});

/** The wire, as a gate: every `/sync` ask hangs until the test opens it. */
function gatedAdapter(): { adapter: EngineAdapter; open: () => void; asks: number } {
  const state = { asks: 0 };
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const adapter = {
    sync: async (params: { since: string }) => {
      state.asks += 1;
      await gate;
      return EMPTY_PAGE(params.since);
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  } as unknown as EngineAdapter;
  return {
    adapter,
    open: () => release(),
    get asks() {
      return state.asks;
    },
  };
}

/** A warm, three-days-stale mirror — what a laptop opened after a weekend holds. */
async function warmStaleStore(): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyResponse({
    changes: { creates: [seedMessage], updates: [], moves: [], deletes: [] },
    cursor: "AA",
    hasMore: false,
    serverTime: ISO,
  });
  await store.setMeta(LAST_DRAIN_AT_META, STALE_STAMP);
  return store;
}

/** The mirror's content, read exactly as a view reads it. */
function MirrorProbe(): React.ReactElement {
  const { useReader, useEngineVersion } = probeHooks;
  useEngineVersion();
  const subject = useReader()
    .list<{ subject: string }>("message")
    .map((m) => m.subject)
    .join(", ");
  return h("div", { "data-testid": "content" }, subject);
}
let probeHooks: typeof import("../app/shell/engine");

const roots: Root[] = [];
afterEach(async () => {
  for (const r of roots) {
    await act(() => r.unmount());
  }
  roots.length = 0;
  document.body.innerHTML = "";
});

async function mount(engine: OhmailEngine, hostOffline = false): Promise<HTMLElement> {
  probeHooks = await import("../app/shell/engine");
  const { EngineProvider } = probeHooks;
  const { MailStateProvider } = await import("../app/shell/MailStateProvider");
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: NOW,
        children: h(EngineProvider, {
          demo: false,
          engine,
          children: h(MailStateProvider, {
            mirrored: 1,
            children: [h(MirrorProbe, { key: "p" }), h(SyncBar, { key: "s", hostOffline })],
          }),
        }),
      }),
    );
  });
  return container;
}

describe("a device stale by days, reopened", () => {
  it("paints the mirror's content LABELED with the network unanswered, and unlabels at the settle", async () => {
    const store = await warmStaleStore();
    const wire = gatedAdapter();
    const engine = new OhmailEngine({ adapter: wire.adapter, store });

    const c = await mount(engine);

    // THE FIRST SETTLED PAINT, wire still shut: the content is on screen — the mirror IS
    // renderable truth — and it is labeled as being three days old. Not a skeleton, not an
    // empty claim, and above all not plain content.
    expect(wire.asks, "the scheduler asked — and the wire has answered nothing").toBeGreaterThan(0);
    expect(c.querySelector('[data-testid="content"]')?.textContent).toContain(
      "the mail already on this device",
    );
    expect(c.textContent, "stale content rendered without its label").toContain("catching up");
    expect(c.textContent).toContain("As of ");

    // THE SETTLE: open the wire, let the drain converge. The label clears in the same pass —
    // the engine notifies AFTER stamping, which is the only reason a quiet tab repaints here.
    wire.open();
    await act(async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
    expect(c.textContent, "the label outlived the catch-up").not.toContain("catching up");
    // And the content never flickered away.
    expect(c.querySelector('[data-testid="content"]')?.textContent).toContain(
      "the mail already on this device",
    );
  });
});

/**
 * ═══ AND ON A PAIRED DESKTOP, THE SAME STALE MIRROR SAYS SOMETHING ELSE ═══════════════════
 *
 * The arm above is right for every door where a drain is genuinely converging behind readable
 * content: the mail is old, something is fetching, and "As of {time} · catching up" is a true
 * report with a spinner and a travelling track to match.
 *
 * On a desktop paired to another computer of the person's own, with that computer switched off,
 * NOTHING IS CATCHING UP. There is no pull in flight, nothing converging, and no reason to expect
 * the number to move — the sentence is an activity claim the code cannot make, and it would stand
 * for as long as the other machine stayed away, which is exactly the period somebody is trying to
 * understand. Worse, it invites the one wrong response: waiting.
 *
 * So the strip's stale arm YIELDS and `HostConnectionLine` says the true thing in its place. What
 * is deliberately NOT suppressed is the state: the ladder still derives `stale`, so the settled
 * clock, the holdings sentence and the mail beat go on working. This withholds one sentence, not
 * a fact — which is why the control below asserts the strip is silent while the mirror is still
 * genuinely stale, rather than asserting the mirror stopped being stale.
 *
 * Driven over the SAME real store, ladder and provider as the case above, so the two cases differ
 * in exactly one input.
 */
describe("the same stale mirror, on a desktop whose host is not answering", () => {
  it("the strip yields and the standing line speaks — exactly one of them, never both", async () => {
    const { HostConnectionLine } = await import("../app/shell/HostConnectionLine");
    const store = await warmStaleStore();
    const wire = gatedAdapter();
    const engine = new OhmailEngine({ adapter: wire.adapter, store });

    const c = await mount(engine, true);

    /* THE PREMISE, asserted rather than assumed: the mirror really is stale. Without this the
       case would pass just as well against a current mirror, where the strip says nothing anyway
       — a green that measures the fixture instead of the rule. */
    expect(wire.asks, "the scheduler asked — the wire has answered nothing").toBeGreaterThan(0);
    expect(c.querySelector('[data-testid="content"]')?.textContent).toContain(
      "the mail already on this device",
    );

    /* THE RULE. No activity claim anywhere. */
    expect(c.textContent, "the strip still claims a catch-up that is not happening")
      .not.toContain("catching up");
    expect(c.textContent, "the strip still carries the freshness label").not.toContain("As of ");
    expect(c.querySelector(".rs-track"), "a travelling track for a drain that is not running")
      .toBeNull();

    /* AND THE TRUE SENTENCE IS THERE INSTEAD — rendered beside the strip, exactly once. */
    const line = document.createElement("div");
    c.appendChild(line);
    const lineRoot = createRoot(line);
    roots.push(lineRoot);
    await act(() => {
      lineRoot.render(
        h(HostConnectionLine, {
          connection: {
            state: "stale" as const,
            words: {
              title: "Can't reach kestrel.",
              detail: "Last answered 3 days ago. Nothing can be changed until it is back.",
              link: null,
            },
          },
        }),
      );
    });
    const answered = [...c.querySelectorAll("*")].filter(
      (el) => el.children.length === 0 && (el.textContent ?? "").includes("Last answered"),
    );
    expect(answered, "the age is stated more than once, or not at all").toHaveLength(1);
    expect(c.textContent).not.toContain("catching up");
  });
});
