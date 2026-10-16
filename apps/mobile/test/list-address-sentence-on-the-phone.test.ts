import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MemoryMirrorStore, type EngineMessage, type Folder, type SyncChange } from "@ohmail/client-engine";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { liveScreener, presentedOf, screeningAnswered, type WorldView } from "../src/state/live";
import { EN as en } from "../src/copy.en";
import { DE as de } from "../src/copy.de";

/**
 * A LIST ADDRESS ON THE PHONE (mail 0150): the wire says a mailing list posts as the sender, the
 * phone's Screener row carries it into the sender sheet, and the sheet says the one sentence in
 * both languages, the German addressing the reader as du. A marked sender that is no list address
 * carries nothing of it.
 */
const NOW = new Date("2026-10-08T12:00:00.000Z");
const RECENT = "2026-10-07T09:00:00.000Z";
const GATE: Folder = "ohmail/Screener";
const SCREENING = screeningAnswered({ dormancyDays: 60, baselineAt: null, scope: "window" });
const view: WorldView = { now: NOW, zone: "UTC", screening: SCREENING, ownAddresses: ["me@example.test"] };
const LIST = "list@lists.example";
const SHOP = "kunden@postfinance-sicherheit.example";

function claim(id: string, from: string, list: boolean): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Ihre Karte ${id}`, from: { name: "PostFinance", address: from }, to: [], cc: [], date: RECENT,
    folder: GATE, snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: RECENT,
    senderCheck: { reason: "impersonation", brand: "PostFinance", domainShared: false, ...(list ? { list: true } : {}) },
  };
}

describe("the list sentence on the phone", () => {
  it("the Screener row of a list address's claim carries the fact, and only that row", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([claim("l1", LIST, true), claim("s1", SHOP, false)].map((m, i) => ({
      type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: m.updatedAt, entity: m,
    })) as SyncChange[]);
    const shelf = liveScreener(presentedOf(store, NOW, false, SCREENING, ["me@example.test"]), view);
    const byKey = new Map(shelf.waiting.map((r) => [r.routeKey, r]));
    expect(byKey.get(LIST)?.checked).toEqual({ brand: "PostFinance", domainShared: false, domain: "lists.example", list: true });
    expect(byKey.get(SHOP)?.checked).toEqual({ brand: "PostFinance", domainShared: false, domain: "postfinance-sicherheit.example" });
  });

  it("the copy twins carry the sentence in both languages, the German addressing the reader as du", () => {
    expect(en.senderCheckList).toBe("Sent through a mailing list — anyone on it can write as this address.");
    expect(de.senderCheckList).toBe("Über eine Mailingliste verschickt — alle auf der Liste können unter dieser Adresse schreiben.");
    expect(/\b(Sie|Ihnen|Ihr|Ihre)\b/.test(de.senderCheckList)).toBe(false);
  });

  it("the sender sheet draws the sentence under the identity line when the row carries the fact", () => {
    const sheet = withoutComments(readFileSync(fileURLToPath(new URL("../src/ui/SenderDetail.tsx", import.meta.url)), "utf8"));
    const at = sheet.indexOf("row.checked.list ?");
    expect(at, "the sheet no longer asks the row's list fact").toBeGreaterThan(sheet.indexOf('testID="sender-check"'));
    expect(sheet.slice(at, at + 200)).toContain("Copy.senderCheckList");
  });
});
