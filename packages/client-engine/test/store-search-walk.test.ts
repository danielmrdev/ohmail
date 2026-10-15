/**
 * SEARCH TAKES HISTORY'S WINDOW — one question's matches walked
 * a page at a time by the store's own cursor, on the walk History uses: at most
 * `HISTORY_PAGE_CACHE_ROWS` rows held however far it goes, a page evicted off screen asked again
 * by the cursor that first asked it, and the device's first paint kept in place under relevance.
 */
import { describe, expect, it } from "vitest";
import {
  HISTORY_PAGE_CACHE_ROWS,
  HISTORY_PAGE_ROWS,
  StoreSearchWalker,
  type EngineMessage,
} from "../src/index.js";
import { FakeStore, idOf, settle } from "./helpers/fake-store.js";

const STORE_ROWS = 74_000;

/** Every message object reachable from the walker's own fields — it may hold positions only. */
function rowsHeldBy(walker: StoreSearchWalker): number {
  const seen = new Set<unknown>();
  let rows = 0;
  const walk = (v: unknown, depth: number): void => {
    if (v === null || typeof v !== "object" || seen.has(v) || depth > 6) return;
    seen.add(v);
    if ("subject" in (v as object) && "folder" in (v as object)) { rows += 1; return; }
    for (const [k, x] of Object.entries(v as object)) {
      if (k === "engine" || k === "source" || k === "hooks" || k === "heldRows") continue;
      walk(x, depth + 1);
    }
  };
  walk(walker, 0);
  return rows;
}

describe("a Search walked through thousands of matches", () => {
  it("holds no more than the page cache's ceiling, re-asks by cursor on the way back, and knows its end", async () => {
    const fake = new FakeStore(STORE_ROWS, { mirror: 20 });
    const engine = await fake.engine();
    const matches = fake.rows.filter((m) => m.subject.includes("invoice"));
    expect(matches.length).toBeGreaterThanOrEqual(3_000);
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "invoice", sort: "date_desc" }, () => [], 0);
    await settle();
    expect(walker.state()).toBe("ready");
    let peak = 0;
    for (let guard = 0; guard < 200 && !walker.atEnd(); guard++) {
      const end = walker.length();
      walker.want(Math.max(0, end - 20), end);
      walker.more();
      await settle(4);
      peak = Math.max(peak, engine.storePageCacheRows());
      expect(rowsHeldBy(walker), "the walker holds positions, never rows").toBe(0);
    }
    expect(walker.atEnd()).toBe(true);
    expect(walker.length()).toBe(matches.length);
    expect(peak, "the one bound, however far the list went").toBeLessThanOrEqual(HISTORY_PAGE_CACHE_ROWS);
    const cursorAt = (slot: number) => `search:${slot === 0 ? "-" : String(slot)}`;
    const firstWalk = fake.asked.filter((a) => a.startsWith("search:"));
    expect(new Set(firstWalk).size, "one request per page, none repeated").toBe(firstWalk.length);

    // Back to a page the cache evicted: asked again, by the cursor that asked it first.
    expect(walker.rowAt(1_500), "evicted off screen").toBeNull();
    const before = fake.asked.length;
    walker.want(1_500, 1_520);
    await settle();
    expect(fake.asked.slice(before)).toEqual([cursorAt(1_500)]);
    expect((walker.rowAt(1_500) as EngineMessage).id).toBe(matches[1_500]!.id);

    // And to the top: page one by no cursor at all.
    const top = fake.asked.length;
    walker.want(0, 20);
    await settle();
    expect(fake.asked.slice(top)).toEqual([cursorAt(0)]);
    expect((walker.rowAt(0) as EngineMessage).id).toBe(matches[0]!.id);
    expect(engine.storePageCacheRows()).toBeLessThanOrEqual(HISTORY_PAGE_CACHE_ROWS);
  });

  it("under relevance the device's rows keep their places in page one, and the store's follow", async () => {
    const fake = new FakeStore(STORE_ROWS, { mirror: 20 });
    const engine = await fake.engine();
    const matches = fake.rows.filter((m) => m.subject.includes("invoice"));
    const device = [matches[7]!.id, matches[3]!.id, idOf(1)];
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "invoice" }, () => device, 0);
    await settle();
    const firstPage = Array.from({ length: HISTORY_PAGE_ROWS }, (_, i) => (walker.rowAt(i) as EngineMessage).id);
    expect(firstPage.slice(0, 2), "the device's rows the store also found, where the device put them")
      .toEqual([matches[7]!.id, matches[3]!.id]);
    expect(new Set(firstPage).size).toBe(HISTORY_PAGE_ROWS);
    expect(firstPage.slice(2)).toEqual(matches.slice(0, HISTORY_PAGE_ROWS).map((m) => m.id).filter((id) => !device.includes(id)));
  });

  it("a verb on a Search row goes through the one door: the row leaves at the press", async () => {
    const fake = new FakeStore(STORE_ROWS, { mirror: 20 });
    const engine = await fake.engine();
    const walker = new StoreSearchWalker(engine);
    walker.start({ query: "invoice" }, () => [], 0);
    await settle();
    const row = walker.rowAt(10) as EngineMessage;
    expect(engine.read().get("message", row.id)).toBeUndefined();
    const pending = engine.mutate({ kind: "message_delete", messageId: row.id });
    expect(walker.rowAt(10), "gone within one paint").toBe("gone");
    expect((await pending).status).toBe("confirmed");
    expect(walker.rowAt(10)).toBe("gone");
  });
});
