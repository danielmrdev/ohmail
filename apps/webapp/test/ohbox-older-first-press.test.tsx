/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { teardownShellEnv } from "./fixtures/live-walk-shell";
import {
  DECIDED, STRANGER, installOlderStore, listed, mountSettled, olderRows, pressLoadOlder, store, type Row,
} from "./fixtures/older-store-shell";

/**
 * Load older mail at scale: a tab keeping the newest window of rows of a large mailbox.
 *
 * The store's Ohbox page is the whole INBOX folder: sixteen presses listed 800 letters the store
 * already held, most from senders never let in, one twice; the let-in sender's older letters came
 * at presses 17 and 18. Here the mirror holds a full window of rows, and past it a held stranger's and a
 * dormant stranger's letters sit newer than the let-in sender's. One press lists exactly those.
 */

beforeEach(installOlderStore);
afterEach(teardownShellEnv);

const id = (tag: string, n: number): string => `00000000-0000-4000-${tag}-${String(n).padStart(12, "0")}`;
const back = (days: number): string => new Date(Date.parse("2025-06-30T09:00:00.000Z") - days * 86_400_000).toISOString();

describe("the first press past a full window", () => {
  it("lists the let-in sender's older letters and nothing else", async () => {
    const held: Row[] = Array.from({ length: 300 }, (_, i) => ({ id: id("a000", i), date: back(i / 10), unread: true, from: STRANGER }));
    const dormant: Row[] = Array.from({ length: 100 }, (_, i) => ({ id: id("b000", i), date: back(40 + i / 10), from: `quiet${i}@example.invalid` }));
    const letIn: Row[] = Array.from({ length: 8 }, (_, i) => ({ id: id("c000", i), date: back(60 + i), from: DECIDED }));
    store.bulk = 9_995;
    store.pageSize = 50; // the server's default page, as production asks it
    store.rows = [...held, ...dormant, ...letIn];
    const el = await mountSettled();
    expect(store.served.length, "the mirror is not filled to the window").toBe(10_000);

    await pressLoadOlder(el);

    // MUTATION: walk at the page size (drop `OLDER_HOP_LIMIT`) and the letters wait for a later press.
    expect(olderRows(el).sort(), "the first press did not bring the let-in sender's older letters, alone")
      .toEqual(letIn.map((m) => m.id).sort());
    const all = listed(el);
    expect(new Set(all).size, "a row is listed twice").toBe(all.length);
  }, 120_000);
});
