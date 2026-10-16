/**
 * AN ACTED-ON ROW STAYS GONE — the shadow (`shadow.ts`, `OhmailEngine.settleConfirmed`).
 *
 * Measured 2026-09-23 on a Cloud-paired desktop: the door answered `/sync` from a copy that had
 * not pulled the write yet, the reconcile drain succeeded, the overlay was dropped and the row
 * came back until the next poll. Every case drives a door that lags the server that took the
 * write; the row may return only through a refusal, and the mirror is the truth once it agrees.
 */
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  CursorExpiredError,
  IndexedDbMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  decodeSeqCursor,
  encodeSeqCursor,
  ohboxView,
  pressVerdict,
  type EngineAdapter,
  type EngineMessage,
  type EngineMutation,
  type MessageStateDTO,
  type SyncChange,
  type SyncResponse,
  type SyncSnapshotPage,
} from "@ohmail/client-engine";
import { SHADOW_DRAIN_BOUND } from "../src/shadow.js";

const NOW = new Date("2026-09-23T09:00:00.000Z");
const NEXT_WEEK = "2026-09-30T07:00:00.000Z";
const STATE_ROW = "st-row-1";

function message(id: string, triage: MessageStateDTO | null): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" }, to: [], cc: [],
    date: NOW.toISOString(), folder: "INBOX", snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}
const pin = (at: string): MessageStateDTO => ({ messageId: "m1", state: "resurfaced", bubbleUpAt: null, setAt: at, updatedAt: at });

/**
 * THE SERVER AND ITS DOOR. `log` is what the server committed; `visible` is how far the door's
 * copy has pulled — `/sync` and the snapshot answer from that copy, exactly as the Cloud-paired
 * desktop's local engine does. `lag` keeps a write out of the copy until `catchUp()`.
 */
class LaggingDoor implements EngineAdapter {
  log: SyncChange[] = [];
  seq = 0;
  visible = 0;
  lag = true;
  refuse: MutationRejectedError | null = null;
  ignoreWrites = false;
  expireNext = false;
  private msg = message("m1", pin(NOW.toISOString()));

  constructor(readonly snapshotting = false) {
    this.commit({ type: "message", op: "create", id: "m1", entity: this.msg });
    this.commit({ type: "message_state", op: "create", id: STATE_ROW, entity: this.msg.triage });
    this.catchUp();
  }
  private commit(c: Omit<SyncChange, "seq" | "updatedAt">): void {
    this.seq += 1;
    this.log.push({ ...c, seq: this.seq, updatedAt: new Date(NOW.getTime() + this.seq * 1000).toISOString() } as SyncChange);
  }
  catchUp(): void { this.visible = this.seq; }
  /** Another device writes the row's state — the proof that the mirror, not a mask, is shown. */
  foreign(state: MessageStateDTO["state"]): void {
    const at = new Date(NOW.getTime() + (this.seq + 1) * 1000).toISOString();
    const st: MessageStateDTO = { messageId: "m1", state, bubbleUpAt: null, setAt: at, updatedAt: at };
    this.msg = { ...this.msg, triage: state === "none" ? null : st };
    this.commit({ type: "message_state", op: "update", id: STATE_ROW, entity: st });
    this.commit({ type: "message", op: "update", id: "m1", entity: this.msg });
  }
  async sync(p: { since: string }): Promise<SyncResponse> {
    if (this.expireNext) { this.expireNext = false; throw new CursorExpiredError(); }
    const since = decodeSeqCursor(p.since) ?? 0;
    const rows = this.log.filter((c) => c.seq > since && c.seq <= this.visible);
    const top = rows.length ? rows[rows.length - 1]!.seq : since;
    return {
      changes: {
        creates: rows.filter((c) => c.op === "create"), updates: rows.filter((c) => c.op === "update"),
        moves: rows.filter((c) => c.op === "move"), deletes: rows.filter((c) => c.op === "delete"),
      },
      cursor: encodeSeqCursor(top), hasMore: false, serverTime: NOW.toISOString(),
    };
  }
  async mutate(m: EngineMutation): Promise<{ changes: SyncChange[]; seq: number | null }> {
    if (this.refuse) throw this.refuse;
    if (!this.ignoreWrites && m.kind === "triage_set") {
      const at = new Date(NOW.getTime() + (this.seq + 1) * 1000).toISOString();
      const st: MessageStateDTO = {
        messageId: "m1", state: m.state as MessageStateDTO["state"],
        bubbleUpAt: m.state === "bubbled_up" ? m.bubbleUpAt ?? null : null, setAt: at, updatedAt: at,
      };
      this.msg = { ...this.msg, triage: st };
      this.commit({ type: "message_state", op: "update", id: STATE_ROW, entity: st });
      this.commit({ type: "message", op: "update", id: "m1", entity: this.msg });
    }
    if (!this.lag) this.catchUp();
    // The triage route's hosted shape: no echo body and no seq.
    return { changes: [], seq: null };
  }
  async withdrawSend() { return { outcome: "unsupported" as const }; }
  async fetchBody(): Promise<null> { return null; }
}
/** The same door with the bootstrap route — the resnapshot case. */
class SnapshottingDoor extends LaggingDoor {
  async snapshot(): Promise<SyncSnapshotPage> {
    const latest = new Map<string, SyncChange>();
    for (const c of this.log) if (c.seq <= this.visible) latest.set(`${c.type}:${c.id}`, c);
    return {
      asOfSeq: this.visible,
      changes: [...latest.values()].map((c) => ({ ...c, op: "create", seq: this.visible })),
      nextCursor: null, window: { days: 90, minRows: 5000 },
    };
  }
}

const resurfaceNextWeek: EngineMutation = { kind: "triage_set", messageId: "m1", state: "bubbled_up", bubbleUpAt: NEXT_WEEK };
const inOhbox = (engine: OhmailEngine): string => {
  const v = ohboxView(engine.read());
  if (v.resurfaced.some((m) => m.id === "m1")) return "resurfaced";
  if (v.newForYou.some((m) => m.id === "m1") || v.previouslySeen.some((m) => m.id === "m1")) return "ohbox";
  return "out";
};
const engineOver = (door: EngineAdapter, store?: IndexedDbMirrorStore) =>
  new OhmailEngine({ adapter: door, ...(store ? { store } : {}), now: () => NOW, outboxAutoReplay: true });

describe("a confirmed verb's row is not shown in its old place by a copy that predates it", () => {
  it("a page minted before the press, then a reconcile read from a lagging door, resurrects nothing", async () => {
    const door = new LaggingDoor();
    const engine = engineOver(door);
    await engine.start();
    expect(inOhbox(engine)).toBe("resurfaced");

    // A drain already in the air when the press lands, carrying a page read before it.
    door.foreign("resurfaced");
    door.catchUp();
    const early = engine.syncOnce();
    const result = await engine.mutate(resurfaceNextWeek);
    await early;
    expect(result.status).toBe("confirmed");
    // The door has not pulled the write: its /sync still says "resurfaced". The row stays gone.
    expect(inOhbox(engine)).toBe("out");
    await engine.syncOnce();
    expect(inOhbox(engine)).toBe("out");

    // The door catches up: the mirror agrees, and from here the mirror is shown, not the mask.
    door.catchUp();
    await engine.syncOnce();
    expect(inOhbox(engine)).toBe("out");
    expect(engine.read().get<EngineMessage>("message", "m1")?.triage?.state).toBe("bubbled_up");
    door.foreign("resurfaced");
    door.catchUp();
    await engine.syncOnce();
    expect(inOhbox(engine), "the shadow retired: another device's later change is shown").toBe("resurfaced");
  });

  it("a resnapshot from the lagging door, stamped at a seq above the row's, resurrects nothing", async () => {
    const door = new SnapshottingDoor(true);
    const engine = engineOver(door);
    await engine.start();
    expect(inOhbox(engine)).toBe("resurfaced");

    door.expireNext = true; // the reconcile drain takes a 410 and re-bootstraps from the copy
    const result = await engine.mutate(resurfaceNextWeek);
    expect(result.status).toBe("confirmed");
    expect(inOhbox(engine)).toBe("out");

    door.catchUp();
    await engine.syncOnce();
    expect(inOhbox(engine)).toBe("out");
    expect(engine.read().get<EngineMessage>("message", "m1")?.triage?.state).toBe("bubbled_up");
  });

  it("another tab opened while the shadow stands does not show the row in its old place", async () => {
    const factory = new IDBFactory();
    const door = new LaggingDoor();
    const storeA = new IndexedDbMirrorStore({ owner: "acct-stale", factory });
    const tabA = engineOver(door, storeA);
    await tabA.start();
    expect(inOhbox(tabA)).toBe("resurfaced");
    expect((await tabA.mutate(resurfaceNextWeek)).status).toBe("confirmed");
    expect(inOhbox(tabA)).toBe("out");

    // A second tab boots from the same database, against the same lagging door.
    const storeB = new IndexedDbMirrorStore({ owner: "acct-stale", factory });
    const tabB = engineOver(door, storeB);
    await tabB.start();
    expect(inOhbox(tabB), "the second tab rebuilt the old row from a disk the confirm had emptied").toBe("out");

    door.catchUp();
    await tabA.syncOnce();
    await tabB.syncOnce();
    expect(inOhbox(tabA)).toBe("out");
    expect(inOhbox(tabB)).toBe("out");
    storeA.close();
    storeB.close();
  });

  it("a refusal lifts the mask at once and hands the surface its reason", async () => {
    const door = new LaggingDoor();
    door.refuse = new MutationRejectedError("another install organizes this mailbox", {
      status: 409, code: "organized_elsewhere", retryable: false,
    });
    const engine = engineOver(door);
    await engine.start();
    const result = await engine.mutate(resurfaceNextWeek);
    expect(result.status).toBe("rolled_back");
    expect(inOhbox(engine)).toBe("resurfaced");
    const verdict = pressVerdict(result);
    expect(verdict.kind).toBe("refused");
    expect(verdict.kind === "refused" ? verdict.refusal?.code : null).toBe("organized_elsewhere");
  });

  it(`a verb the mirror never agrees with stops masking after ${SHADOW_DRAIN_BOUND} drains, not at a time`, async () => {
    const door = new LaggingDoor();
    door.ignoreWrites = true; // a no-op on the server: the overlay predicted a change that never comes
    door.lag = false;
    const engine = engineOver(door);
    await engine.start();
    await engine.mutate(resurfaceNextWeek);
    expect(inOhbox(engine)).toBe("out");
    for (let i = 1; i < SHADOW_DRAIN_BOUND; i++) {
      await engine.syncOnce();
      expect(inOhbox(engine), `drain ${i}`).toBe("out");
    }
    await engine.syncOnce();
    expect(inOhbox(engine), "the mirror is the truth after the bound").toBe("resurfaced");
  });

  it("a newer verb on the row replaces the shadow, so an Undo is never shown undone", async () => {
    const door = new LaggingDoor();
    const engine = engineOver(door);
    await engine.start();
    await engine.mutate(resurfaceNextWeek);
    expect(inOhbox(engine)).toBe("out");
    // The Undo: back to resurfaced, while the door still lags both writes.
    await engine.mutate({ kind: "triage_set", messageId: "m1", state: "resurfaced" });
    expect(inOhbox(engine)).toBe("resurfaced");
    door.catchUp();
    await engine.syncOnce();
    expect(inOhbox(engine)).toBe("resurfaced");
    await engine.syncOnce();
    expect(inOhbox(engine)).toBe("resurfaced");
  });
});
