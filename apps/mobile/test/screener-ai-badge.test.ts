import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, type SyncChange } from "@ohmail/client-engine";
import { liveScreener, presentedOf, type WorldView } from "../src/state/live";
import type { ServerWaitingSender } from "../src/net/screener";
import { Copy } from "../src/copy";

/**
 * THE PHONE'S SUGGESTION BADGE RENDERS FROM THE MIRROR — the narrow `screener_suggestion`
 * entity the drain now asks for. Before it, a live row's `ai` was always null and the badge
 * line in `app/(tabs)/screener.tsx` was unreachable on a live account. The shared derivation
 * fills `dto.ai`; `rowOf` maps it through `AI_DESTS` onto the row the tab renders.
 * MUTATION-WATCH: drop `"screener_suggestion"` from `SYNC_ENTITY_TYPES` and the boot test's
 * membership case goes red; drop the selector fill and the badge case below goes red.
 */

const view: WorldView = { now: new Date("2026-09-18T12:00:00Z"), zone: "UTC" };

let seq = 0;
const change = (type: string, id: string, entity: unknown): SyncChange =>
  ({ type, op: "create", id, seq: ++seq, updatedAt: view.now.toISOString(), entity } as SyncChange);

async function mirrorWith(suggestion: boolean): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  const date = "2026-09-17T08:00:00.000Z";
  await store.applyChanges([
    change("message", "m-1", {
      id: "m-1", accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
      subject: "Hello there", from: { name: "New Sender", address: "new@stranger.test" },
      to: [], cc: [], date, folder: "ohmail/Screener", snippet: "s", unread: true,
      hasAttachments: false, attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: date,
    }),
    ...(suggestion
      ? [change("screener_suggestion", "sg-1", {
        id: "sg-1", messageId: "m-1", senderKey: "new@stranger.test",
        decision: "yes", destination: "INBOX", spam: false, confidence: 0.8,
        boughtAt: view.now.toISOString(), updatedAt: view.now.toISOString(),
      })]
      : []),
  ]);
  return store;
}

describe("a bought suggestion reaches the phone's screener row", () => {
  it("the row carries the verdict the badge renders", async () => {
    const store = await mirrorWith(true);
    const rows = liveScreener(presentedOf(store, view.now), view);
    expect(rows.waiting).toHaveLength(1);
    expect(rows.waiting[0]!.ai).toEqual({ dest: "ohbox", confidence: 0.8, rationale: "" });
    // The badge line itself: the copy the tab renders for exactly this row state.
    expect(Copy.aiSuggests("Ohbox", 0.8)).toContain("0.80");
  });

  it("without a suggestion the row honestly has none", async () => {
    const store = await mirrorWith(false);
    const rows = liveScreener(presentedOf(store, view.now), view);
    expect(rows.waiting).toHaveLength(1);
    expect(rows.waiting[0]!.ai).toBeNull();
  });
});

/**
 * THE PAIRED DOOR'S MINTED ROWS CARRY THE SAME BADGE — the join of the mirror's advice onto
 * `GET /screener` rows by sender key. The route's parse carries no advice and the mirror is
 * windowed, so a sender the route names and the mirror cannot back was minted with `ai: null`
 * even while the mirror held a live `screener_suggestion` for them (the suggestion's cascade
 * follows a removal, never an absence). MUTATION-WATCH: drop the `advice` join in
 * `liveScreener`'s server path and the first case below goes red.
 */
describe("a bought suggestion reaches a server-minted row the mirror cannot back", () => {
  const serverRow = (address: string): ServerWaitingSender => ({
    messageId: "m-far", address, name: "Far Sender",
    receivedAt: "2026-09-17T09:00:00.000Z", subject: "Hello from afar", snippet: "s",
  });

  async function mirrorWithAdvice(decision: "yes" | "hold" | null): Promise<MemoryMirrorStore> {
    const store = new MemoryMirrorStore();
    await store.load();
    if (decision !== null) {
      await store.applyChanges([
        change("screener_suggestion", "sg-far", {
          id: "sg-far", messageId: "m-far", senderKey: "far@stranger.test",
          decision, destination: decision === "hold" ? "ohmail/Screener" : "INBOX",
          spam: false, confidence: 0.9,
          boughtAt: view.now.toISOString(), updatedAt: view.now.toISOString(),
        }),
      ]);
    }
    return store;
  }

  it("the minted row's badge is the mirror's verdict", async () => {
    const store = await mirrorWithAdvice("yes");
    const rows = liveScreener(presentedOf(store, view.now), view, {}, [serverRow("far@stranger.test")]);
    expect(rows.source).toBe("server");
    expect(rows.waiting).toHaveLength(1);
    expect(rows.waiting[0]!.ai).toEqual({ dest: "ohbox", confidence: 0.9, rationale: "" });
  });

  it("no advice on record, no badge — the mint itself stands", async () => {
    const store = await mirrorWithAdvice(null);
    const rows = liveScreener(presentedOf(store, view.now), view, {}, [serverRow("far@stranger.test")]);
    expect(rows.waiting).toHaveLength(1);
    expect(rows.waiting[0]!.ai).toBeNull();
  });

  it("a hold is a sentence, not a destination — the join applies the same badge filter", async () => {
    const store = await mirrorWithAdvice("hold");
    const rows = liveScreener(presentedOf(store, view.now), view, {}, [serverRow("far@stranger.test")]);
    expect(rows.waiting).toHaveLength(1);
    expect(rows.waiting[0]!.ai).toBeNull();
  });

  it("the sender sheet's no-reason sentence quotes nothing, in both languages", async () => {
    // Mirror advice carries no model text; the sheet picks this form when `rationale` is "".
    const { DE } = await import("../src/copy.de");
    for (const s of [Copy.senderAiSuggestionNoReason("Ohbox", "0.90"),
      DE.senderAiSuggestionNoReason("Ohbox", "0,90")]) {
      expect(s).toContain("0");
      expect(s).not.toMatch(/[“„"]/u);
    }
  });
});
