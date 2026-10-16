/**
 * On the phone, the sender sheet said "First contact. Nothing from this sender has reached
 * the Ohbox" on every waiting card, over a sender whose answer the gate had admitted to the Ohbox. It
 * says first contact only while nothing of theirs is past the gate, and otherwise how much is. The
 * sheet is measured by its code with comments blanked (no RN renderer here), the count by the row.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryMirrorStore, type SyncChange } from "@ohmail/client-engine";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { liveScreener, presentedOf, type WorldView } from "../src/state/live";
import { Copy } from "../src/copy";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sheet = withoutComments(fs.readFileSync(path.join(HERE, "..", "src/ui/SenderDetail.tsx"), "utf8"));
const view: WorldView = { now: new Date("2026-10-10T06:46:00Z"), zone: "UTC" };
const FROM = "b+r31x@answers.example";

async function rows(withAnswer: boolean) {
  const store = new MemoryMirrorStore();
  await store.load();
  const at = "2026-10-10T06:40:00.000Z";
  const letter = (id: string, folder: string, extra: Record<string, unknown> = {}) => ({
    type: "message", op: "create", id, seq: id === "r8" ? 2 : 1, updatedAt: at,
    entity: {
      id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `S ${id}`,
      from: { name: null, address: FROM }, to: [], cc: [], date: at, arrivedAt: at, folder, snippet: "s", unread: true,
      hasAttachments: false, attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: at, senderCheck: null, ...extra,
    },
  }) as SyncChange;
  await store.applyChanges([
    letter("r8", "ohmail/Screener"),
    ...(withAnswer ? [letter("r3", "INBOX", { placeDecided: true })] : []),
  ]);
  return liveScreener(presentedOf(store, view.now), view).waiting;
}

describe("the sender sheet says first contact only when it is", () => {
  it("draws the past-the-gate sentence when the row says some of their mail got through", () => {
    expect(sheet).toMatch(/\{row\.reached > 0 \? Copy\.senderPastTheGate\(row\.reached\) : Copy\.senderFirstContact\}/);
  });

  it("an admitted answer in the Ohbox makes the row not first contact, and the held letter alone waits", async () => {
    const [row] = await rows(true);
    expect(row?.held.map((h) => h.id)).toEqual(["r8"]);
    expect(row?.reached).toBe(1);
    expect(Copy.senderPastTheGate(1)).toContain("already in your mail");
  });

  it("CONTROL: a sender with nothing past the gate is first contact", async () => {
    const [row] = await rows(false);
    expect(row?.reached).toBe(0);
  });
});
