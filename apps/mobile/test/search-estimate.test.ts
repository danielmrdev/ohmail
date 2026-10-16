/**
 * THE PHONE'S COUNT FOLLOWS ITS FIRST PAGE, BY THE BROWSER'S RULE: the phone's Search walker is
 * the one walker, so it asks the page, then the estimate,
 * then the exact summary only when the estimate was cut, and the count line reads "about N" from
 * the estimate until the exact count replaces it. Against a store answering the parts' contract.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type EngineMessage,
  type ServerSearchOpts,
  type SyncResponse,
} from "@ohmail/client-engine";
import { storeSearchWalkerFor } from "../src/state/live";
import { searchCountLine } from "../src/state/search-count";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function msg(i: number): EngineMessage {
  return {
    id: `m${i}`, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `Invoice ${i}`,
    from: { name: null, address: "billing@example.test" }, to: [], cc: [], date: NOW.toISOString(), folder: "INBOX",
    snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

/** A store of `matches` hits whose arms keep 200 candidates; the summary waits on `release`. */
async function phoneWith(matches: number): Promise<{ engine: OhmailEngine; asked: string[]; release: () => void }> {
  const asked: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const kept = Math.min(matches, 200);
  const cut = matches > kept;
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    searchServer: async (_q: string, o: ServerSearchOpts) => {
      asked.push(o.parts ?? "both");
      if (o.parts === "summary") {
        await held;
        return { items: [], total: matches, totalExact: true, ms: 40 };
      }
      if (o.parts === "estimate") {
        return { items: [], total: kept, totalExact: !cut, ...(cut ? { totalEstimate: Math.round(matches * 0.9) } : {}), ms: 3 };
      }
      return { items: Array.from({ length: Math.min(50, kept) }, (_, i) => msg(i)), total: kept, totalExact: !cut, ms: 6 };
    },
  } as unknown as EngineAdapter;
  const store = new MemoryMirrorStore();
  await store.load();
  return { engine: new OhmailEngine({ adapter, store, now: () => NOW }), asked, release };
}

describe("the phone's Search count", () => {
  it("a cut search: page, estimate, summary — about N, then the exact N", async () => {
    const { engine, asked, release } = await phoneWith(7_874);
    const walker = storeSearchWalkerFor(engine);
    walker.start({ query: "invoice" }, () => [], 0);
    await tick();
    expect(asked).toEqual(["page", "estimate", "summary"]);
    expect(walker.length(), "the page is on screen while the summary is out").toBe(50);
    expect(searchCountLine(walker.info()!)).toBe("Searched your whole mailbox — about 7087 matched");
    release();
    await tick();
    expect(searchCountLine(walker.info()!)).toBe("Searched your whole mailbox — 7874 matched");
    expect(asked).toEqual(["page", "estimate", "summary"]);
  });

  it("an uncut search: page and estimate, the exact count, no summary", async () => {
    const { engine, asked } = await phoneWith(38);
    const walker = storeSearchWalkerFor(engine);
    walker.start({ query: "invoice" }, () => [], 0);
    await tick();
    await tick();
    expect(asked).toEqual(["page", "estimate"]);
    expect(searchCountLine(walker.info()!)).toBe("Searched your whole mailbox — 38 matched");
  });

  it("before the estimate says, the page's lower bound", () => {
    expect(searchCountLine({ total: 200, totalExact: false, about: null })).toBe("Searched your whole mailbox — at least 200 matched");
  });

  it("the screen's count line is that rule, and the hook hands it the estimate", () => {
    expect(read("../app/search.tsx")).toContain("searchCountLine(store)");
    expect(read("../src/state/store-views.ts")).toContain("about: info?.about ?? null");
  });
});
