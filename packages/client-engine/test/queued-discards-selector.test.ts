/**
 * THE QUEUED DISCARDS, AS ONE ENGINE SELECTOR. A draft discard that cannot reach the account waits
 * on the queue while its overlay erases the draft, so the strip beside the abandoned rows is the
 * only place the draft is still named. The web strip and the phone both read `queuedDiscards()`;
 * this file pins its membership (the queue's own) and its snapshot identity.
 * Mutations: the kind filter narrowed → all three red (and the web and phone lists); the kept
 * snapshot dropped → case 3 red.
 */
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbMirrorStore, MutationRejectedError, OhmailEngine, type EngineMutation,
} from "@ohmail/client-engine";

const NOW = new Date("2026-09-28T09:00:00.000Z");

const draft = (id: string) => ({
  id, mailboxId: "mb", threadId: null, inReplyToMessageId: null, subject: `Draft ${id}`, body: "words",
  to: [], cc: [], bcc: [], rationale: null, status: "draft",
  createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
});

/** `offline` reaches every draft but those in `through`; `hang` holds the request open. */
interface Net { offline: boolean; through: Set<string>; hang: Promise<void> | null }

async function scene(ids: readonly string[]) {
  const store = new IndexedDbMirrorStore({ owner: "acct-queued-discards", factory: new IDBFactory() });
  await store.load();
  const net: Net = { offline: true, through: new Set(), hang: null };
  const sent: EngineMutation[] = [];
  let seq = 0;
  const engine = new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: {
          creates: seq > 0 ? [] : ids.map((id) => ({
            type: "draft", op: "create", id, seq: ++seq, updatedAt: NOW.toISOString(), entity: draft(id),
          })),
          updates: [], moves: [], deletes: [],
        },
        cursor: String(seq), hasMore: false, serverTime: NOW.toISOString(),
      }),
      fetchBody: async () => null,
      mutate: async (m: EngineMutation) => {
        sent.push(m);
        if (net.hang) await net.hang;
        const target = (m as { draftId?: string }).draftId ?? "";
        if (net.offline && !net.through.has(target)) throw new MutationRejectedError("network failure", { code: "network", retryable: true });
        return { changes: [], seq: null };
      },
    } as never,
  });
  await engine.start();
  return { engine, store, net, sent };
}

const ids = (engine: OhmailEngine) => engine.queuedDiscards().map((q) => q.id);

describe("queuedDiscards — the draft discards waiting on the queue", () => {
  it("1 — lists a queued discard as a frozen pick, and nothing else the queue holds", async () => {
    const { engine, store } = await scene(["d1", "d2"]);
    const res = await engine.mutate({ kind: "draft_discard", draftId: "d1" });
    expect(res.status, "the offline discard did not queue").toBe("queued");
    // A second verb on the queue that is not a discard stays out of the list.
    await engine.mutate({
      kind: "draft_save", draftId: "d2", mailboxId: "mb", subject: "x", body: "y", to: [], cc: [], bcc: [],
    } as unknown as EngineMutation);
    expect(engine.pendingMutations().map((q) => q.mutation.kind).sort(), "the control verb did not queue")
      .toEqual(["draft_discard", "draft_save"]);
    const listed = engine.queuedDiscards();
    expect(listed.map((q) => [q.id, q.key, q.mutation.kind]), "the queued discard is on the queue and not listed")
      .toEqual([[res.id, res.key, "draft_discard"]]);
    expect(Object.isFrozen(listed) && Object.isFrozen(listed[0]), "the engine handed out a live entry").toBe(true);
    expect(engine.read().get("draft", "d1"), "the overlay did not erase the draft").toBeUndefined();
    store.close();
  });

  it("2 — on the wire it is not listed; withdrawn it is not listed; confirmed it is gone", async () => {
    const { engine, store, net } = await scene(["d1", "d2"]);
    const a = await engine.mutate({ kind: "draft_discard", draftId: "d1" });
    const b = await engine.mutate({ kind: "draft_discard", draftId: "d2" });
    expect(ids(engine)).toEqual([a.id, b.id]);

    let release!: () => void;
    net.hang = new Promise<void>((r) => { release = r; });
    net.through.add("d1");
    const flying = engine.retryQueued(a.id);
    for (let i = 0; i < 20 && ids(engine).includes(a.id); i++) await Promise.resolve();
    expect(ids(engine), "a discard on the wire is still listed as waiting").toEqual([b.id]);
    release();
    net.hang = null;
    expect((await flying)?.status).toBe("confirmed");
    expect(ids(engine)).toEqual([b.id]);

    expect(await engine.withdrawQueued(b.key)).toBe("withdrawn");
    expect(ids(engine), "a withdrawn discard is still listed").toEqual([]);
    expect(engine.read().get("draft", "d2"), "the withdrawn discard's draft did not come back").toBeDefined();
    store.close();
  });

  it("3 — one snapshot while nothing changed; a held-back discard is listed again at the END", async () => {
    const { engine, store } = await scene(["d1", "d2"]);
    const a = await engine.mutate({ kind: "draft_discard", draftId: "d1" });
    const b = await engine.mutate({ kind: "draft_discard", draftId: "d2" });
    const first = engine.queuedDiscards();
    expect(engine.queuedDiscards(), "an unchanged queue rebuilt its snapshot").toBe(first);

    // Tried again and still unreachable: the entry goes back on the queue behind the other one.
    expect((await engine.retryQueued(a.id))?.status).toBe("queued");
    const after = engine.queuedDiscards();
    expect(after.map((q) => q.id), "the held-back discard is not listed at the end").toEqual([b.id, a.id]);
    expect(after, "an order change kept the old snapshot").not.toBe(first);
    store.close();
  });
});
