import { describe, expect, it } from "vitest";
import {
  FOLDER_OF_VIEW,
  ohboxRows,
  rowOpenTarget,
  type EngineMessage,
  type EntityReader,
  type MessageStateDTO,
} from "@ohmail/client-engine";

/**
 * THE MESSAGE A ROW-OPENED CONVERSATION IS ACTED ON IS THE ROW'S OWN. `a1` is from Lena, unread,
 * with a file; `x2` is newer and is each member the Ohbox does not show as a row member, or our own
 * reply. The row opens at `a1` in every case, and the helper answers `a1` for it — a recomputation
 * over the whole thread answered `x2` (HIGH 1). The opened message stays the
 * target while it is a member, after the open reads it; a Resurfaced row answers its focus.
 */

const SENT = "Sent" as EngineMessage["folder"];
const LENA = { name: "Lena", address: "lena@example.invalid" };
const ME = { name: "Me", address: "me@example.invalid" };

function msg(p: Partial<EngineMessage> & { id: string; at: string }): EngineMessage {
  const { at, ...rest } = p;
  return {
    accountId: "a", mailboxId: "mb", threadId: "T", messageIdHeader: null, subject: "Q3 plan",
    from: LENA, to: [], cc: [], date: at, arrivedAt: at, folder: FOLDER_OF_VIEW.ohbox, snippet: "",
    unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: at,
    ...rest,
  } as EngineMessage;
}

function readerOf(messages: EngineMessage[]): EntityReader {
  return {
    list: <T,>(type: string) => (type === "message" ? messages : []) as T[],
    get: <T,>(type: string, id: string) => (type === "message" ? messages.find((m) => m.id === id) : undefined) as T | undefined,
    entries: <T,>(type: string) => (type === "message" ? messages : []).map((entity, i) => ({ id: entity.id, entity: entity as T, seq: i })),
    version: () => 1,
  } as unknown as EntityReader;
}

/** What a press on the conversation's row opens: the row's own target, from the rows the Ohbox draws. */
function rowTargetOf(reader: EntityReader, key = "T"): string | null {
  const rows = ohboxRows(reader);
  for (const r of [...rows.resurfaced, ...rows.new, ...rows.earlier]) if (r.key === key) return r.openTarget.id;
  return null;
}

const rowA1 = msg({ id: "a1", at: "2026-09-20T08:00:00.000Z", unread: true, hasAttachments: true, attachmentCount: 1 });
const NEWER = "2026-09-20T09:00:00.000Z";
const laterX2: Record<string, EngineMessage> = {
  "our away answer": msg({ id: "x2", at: NEWER, folder: SENT, from: ME, autoReplyByUs: true }),
  "our calendar acknowledgement": msg({ id: "x2", at: NEWER, folder: SENT, from: ME, itipReplyHeader: true }),
  "our own reply, newer than the unread a1": msg({ id: "x2", at: NEWER, folder: SENT, from: ME }),
  "a stranger's reply held in the Screener": msg({ id: "x2", at: NEWER, folder: FOLDER_OF_VIEW.screener, from: { name: "S", address: "s@elsewhere.invalid" } }),
  "a member filed to Junk": msg({ id: "x2", at: NEWER, folder: FOLDER_OF_VIEW.spam, from: { name: "J", address: "j@elsewhere.invalid" } }),
};

describe("a row-opened conversation acts on the row's own target", () => {
  for (const [label, x2] of Object.entries(laterX2)) {
    it(`${label}: the row opens a1, and a1 is what it acts on`, () => {
      const reader = readerOf([rowA1, x2]);
      expect(rowTargetOf(reader), "the row a press opens").toBe("a1");
      expect(rowOpenTarget(reader, rowA1).id).toBe("a1");
    });
  }

  it("a message the row does not hold, opened as the conversation, gives way to the row's target", () => {
    for (const label of ["our away answer", "our calendar acknowledgement"]) {
      const x2 = laterX2[label]!;
      expect(rowOpenTarget(readerOf([rowA1, x2]), x2).id, label).toBe("a1");
    }
  });

  /**
   * A held message stands in no Ohbox row (its PLACE is the gate or Quarantine), so opened, it is
   * what is acted on — never redirected to a conversation another sender's header threaded it into.
   * MUTATION WATCHED: drop the held arm in `rowOpenTarget` and both answer `a1`.
   */
  it("a held message, opened, is acted on itself", () => {
    for (const label of ["a stranger's reply held in the Screener", "a member filed to Junk"]) {
      const x2 = laterX2[label]!;
      expect(rowOpenTarget(readerOf([rowA1, x2]), x2).id, label).toBe("x2");
      const pin: MessageStateDTO = { messageId: "a1", state: "resurfaced", bubbleUpAt: null, setAt: "2026-09-19T07:00:00.000Z", updatedAt: "2026-09-19T07:00:00.000Z" };
      expect(rowOpenTarget(readerOf([{ ...rowA1, triage: pin }, x2]), x2).id, `${label}, resurfaced`).toBe("x2");
    }
  });

  it("our own reply is a row member: a conversation opened at it is acted on at it", () => {
    const own = laterX2["our own reply, newer than the unread a1"]!;
    expect(rowOpenTarget(readerOf([rowA1, own]), own).id).toBe("x2");
  });

  it("the opened message stays the target after the open reads it, where the row's target moves", () => {
    const a2 = msg({ id: "a2", at: NEWER, unread: true });
    expect(rowTargetOf(readerOf([rowA1, a2])), "before the open").toBe("a2");
    const read = readerOf([rowA1, { ...a2, unread: false }]);
    expect(rowTargetOf(read), "the premise: the row's own target moved to the older unread member").toBe("a1");
    expect(rowOpenTarget(read, { ...a2, unread: false }, "a2").id).toBe("a2");
  });

  it("a Resurfaced conversation ending in our own reply acts on its focus, the pinned original", () => {
    const pinned: MessageStateDTO = { messageId: "a1", state: "resurfaced", bubbleUpAt: null, setAt: "2026-09-21T07:00:00.000Z", updatedAt: "2026-09-21T07:00:00.000Z" };
    const original = { ...rowA1, unread: false, triage: pinned };
    const reply = msg({ id: "r2", at: NEWER, folder: SENT, from: ME });
    const reader = readerOf([original, reply]);
    expect(rowTargetOf(reader), "the Resurfaced row opens at its focus").toBe("a1");
    expect(rowOpenTarget(reader, original).id).toBe("a1");
  });

  it("CONTROL: the FX06 shape — a read first message and an unread reply with the file — opens at the reply", () => {
    const root = msg({ id: "root", at: "2026-09-20T08:06:00.000Z" });
    const reply = msg({ id: "reply", at: "2026-09-20T08:07:00.000Z", unread: true, hasAttachments: true, attachmentCount: 1 });
    const reader = readerOf([root, reply]);
    expect(rowTargetOf(reader)).toBe("reply");
    expect(rowOpenTarget(reader, reply).id).toBe("reply");
  });

  it("CONTROL: with no row for its conversation, the opened message is the target", () => {
    const junk = msg({ id: "j1", at: NEWER, threadId: "J", folder: FOLDER_OF_VIEW.spam });
    expect(rowOpenTarget(readerOf([rowA1, junk]), junk).id).toBe("j1");
  });
});
