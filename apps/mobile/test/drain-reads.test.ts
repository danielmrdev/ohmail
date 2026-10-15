import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type EngineMessage,
  type ScreenerWaitingWire,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import { drainReads } from "../src/state/drain-reads";
import { foldersFlag } from "../src/state/folders-flag";

/**
 * THE ENGINE'S QUEUE READS ARE ASKED ONCE PER SESSION, THEN BY THE SETTLE. The shipped drain read
 * (`drain-reads.ts`, what the world's flag machine calls at boot and after every drain) over a real
 * engine and the real flag machine: boot asks the queue page and the offer once; three idle drains
 * ask neither again; a gate arrival makes the engine's settle ask the page once more.
 */

const NOW = new Date("2026-09-29T09:00:00.000Z");
const page = (ids: string[]): ScreenerWaitingWire => ({
  items: ids.map((id) => ({
    messageId: id, address: `${id}@example.test`, name: null, receivedAt: NOW.toISOString(),
    subject: `s ${id}`, snippet: "s", mailboxId: "mb",
  })),
  nextCursor: null, total: ids.length, inFlight: [],
});

function msg(id: string, folder: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: `${id}@example.test` },
    to: [], cc: [], date: NOW.toISOString(), folder, snippet: "s", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  } as EngineMessage;
}

function rig() {
  const pages: SyncChange[][] = [];
  const asks = { queue: 0, offer: 0, rest: 0, consent: 0 };
  let seq = 0;
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: pages.shift() ?? [], updates: [], moves: [], deletes: [] },
      cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async () => ({ ok: true as const, changes: [] }),
    fetchBody: async () => null,
    screenerWaiting: async () => { asks.queue += 1; return page(["a"]); },
    unscreened: async () => { asks.offer += 1; return { groups: [], total: 0, max: 200 }; },
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
  const flag = foldersFlag({
    read: drainReads<{ on: boolean }>({
      rest: [() => { asks.rest += 1; }],
      consent: async () => { asks.consent += 1; return { on: false }; },
      engine,
    }),
    write: async (on) => ({ on }),
    apply: () => undefined,
    drain: () => undefined,
  });
  const push = (m: EngineMessage) => pages.push([
    { type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: m } as SyncChange,
  ]);
  return { engine, flag, asks, push };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the drain read's cadence", () => {
  it("boot asks once; idle drains ask nothing more; a gate arrival asks the page once", async () => {
    const { engine, flag, asks, push } = rig();
    await engine.start();
    await flag.refresh();
    await flush();
    expect(asks).toMatchObject({ queue: 1, offer: 1, rest: 1, consent: 1 });
    for (let i = 0; i < 3; i++) {
      await engine.syncOnce();
      await flag.refresh();
      await flush();
    }
    expect(asks, "an idle drain re-asked the engine's queue reads").toMatchObject({ queue: 1, offer: 1 });
    expect(asks.rest, "the REST reads keep the drain cadence").toBe(4);
    push(msg("held1", "ohmail/Screener"));
    await engine.syncOnce();
    await flag.refresh();
    await flush();
    expect(asks.queue, "a gate arrival did not re-ask the page").toBe(2);
  });
});
