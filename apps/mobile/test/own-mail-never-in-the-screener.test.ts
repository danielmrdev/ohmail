import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, type EngineMessage, type Folder, type SyncChange } from "@ohmail/client-engine";
import { liveOhbox, liveScreener, presentedOf, screeningAnswered, type WorldView } from "../src/state/live";

/**
 * THE PHONE, THROUGH THE SHARED PARTITION (ruling 2026-09-25, row OWN-ADDRESS-GATE-ROW-IS-STILL-A-QUEUE-ROW).
 *
 * A message from the account's own address sitting in `ohmail/Screener` is in the phone's Ohbox
 * and is no row on its Screener shelf, while a stranger's message beside it still is. The phone
 * draws both from `presentedOf` — the one partition the web app and the desktop read — so this
 * reddens with the engine's own guard (`own-mail-never-a-screener-decision.test.ts`).
 */

const NOW = new Date("2026-09-25T12:00:00.000Z");
const RECENT = "2026-09-24T09:00:00.000Z";
const GATE: Folder = "ohmail/Screener";
const OWN = "me@example.test";
const STRANGER = "them@example.test";
const SCREENING = screeningAnswered({ dormancyDays: 60, baselineAt: null, scope: "window" });
const view: WorldView = { now: NOW, zone: "UTC", screening: SCREENING, ownAddresses: [OWN] };

function msg(id: string, from: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [], date: RECENT,
    folder: GATE, snippet: `snippet ${id}`, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: RECENT,
  };
}

async function gateWithOwnMail(): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([msg("own", OWN), msg("them", STRANGER)].map((m, i) => ({
    type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: m.updatedAt, entity: m,
  })) as SyncChange[]);
  return store;
}

describe("own mail held at the gate, on the phone", () => {
  it("is in the Ohbox and is no Screener row; the stranger is the one row", async () => {
    const store = await gateWithOwnMail();
    const pres = presentedOf(store, NOW, false, SCREENING, [OWN]);

    const ohbox = liveOhbox(pres, view);
    expect(ohbox.fresh.map((m) => m.id)).toEqual(["own"]);

    const shelf = liveScreener(pres, view);
    expect(shelf.waitingPending).toBe(false);
    expect(shelf.waiting.map((r) => r.routeKey)).toEqual([STRANGER]);
  });

  it("CONTROL — an address the phone does not know as the account's is a row at the gate", async () => {
    const store = await gateWithOwnMail();
    const pres = presentedOf(store, NOW, false, SCREENING, []);

    expect(liveOhbox(pres, { ...view, ownAddresses: [] }).fresh).toEqual([]);
    expect(liveScreener(pres, { ...view, ownAddresses: [] }).waiting.map((r) => r.routeKey).sort())
      .toEqual([OWN, STRANGER].sort());
  });
});
