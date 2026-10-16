/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { teardownShellEnv, textOf } from "./fixtures/live-walk-shell";
import {
  HELD, OHBOX, OLDER, installOlderStore, listed, mountSettled, olderRows, pressLoadOlder, store,
  type Row,
} from "./fixtures/older-store-shell";

/**
 * "Load older mail" over a store this device already holds whole.
 *
 * Measured on the deployed 0.25.2 web app: every message in the tab's store, under the
 * window's floor, and the Ohbox still offered older mail; the press listed fifty rows the store
 * held, forty-four of them twice, headed by a recent unread letter. The offer read the window
 * POLICY and page one started at the server's newest row. Mounted here: the real shell and engine,
 * the store answering its timeline and the Ohbox's own pages, with and without mail past the window.
 */

beforeEach(installOlderStore);
afterEach(teardownShellEnv);

describe("the Ohbox's older mail is the store's to offer", () => {
  it("a store this device holds whole offers no older mail, and asks for no page", async () => {
    const el = await mountSettled();
    // The fixture has mail on screen, and the store holds exactly what was served.
    expect(listed(el).length, "the Ohbox rendered no rows").toBeGreaterThan(0);
    expect(store.served.length).toBe(5);

    expect(textOf(el), "offered older mail over a store this device holds whole")
      .not.toContain(OHBOX.olderAction);
    expect(olderRows(el)).toEqual([]);
    expect(store.asks, "a page was asked of the store with nothing older in it").toEqual([]);
  }, 30_000);

  it("a store holding older mail still offers it, and the page starts at the store's edge", async () => {
    store.rows = OLDER;
    const el = await mountSettled();
    expect(textOf(el), "a windowed account with older mail lost the way back").toContain(OHBOX.olderAction);

    await pressLoadOlder(el);

    // Page one started below the newest month the device holds only part of.
    expect(store.asks[0]?.get("beforeDate")).toBe(OLDER[0]!.date);
    expect(store.asks[0]?.get("cursor")).toBeNull();
    const shown = olderRows(el);
    expect(shown.length, "the press listed nothing").toBeGreaterThan(0);
    // Only mail the store holds and this device does not, never a row already on screen.
    for (const id of shown) expect(OLDER.map((m) => m.id)).toContain(id);
    const all = listed(el);
    expect(new Set(all).size, "a row is listed twice").toBe(all.length);
    // And every Older row is older than every row above it.
    const above = all.filter((id) => !shown.includes(id));
    const dateOf = (id: string): string =>
      OLDER.find((m) => m.id === id)?.date ?? store.served.find((m) => m.id === id)?.date ?? "";
    const oldestAbove = above.map(dateOf).sort()[0]!;
    for (const id of shown) expect(dateOf(id) < oldestAbove, `${id} is not older than the list above it`).toBe(true);
  }, 30_000);

  it("a server that ignores the edge re-serves held mail, and none of it is listed again", async () => {
    // The overlap shape: page one starts at the newest row, which the device already shows or
    // holds elsewhere (the Screener's letter). One press walks past them to mail it does not hold.
    store.rows = OLDER;
    store.honoursEdge = false;
    const el = await mountSettled();

    await pressLoadOlder(el);

    expect(store.asks.length, "the press stopped on a page of rows already shown").toBeGreaterThan(1);
    const shown = olderRows(el);
    expect(shown.length).toBeGreaterThan(0);
    for (const id of shown) expect(OLDER.map((m) => m.id), `${id} is held by this device`).toContain(id);
    const all = listed(el);
    expect(new Set(all).size, "a row is listed twice").toBe(all.length);
  }, 30_000);

  /**
   * the Windows rig: the Ohbox listed only the person's own sent rows, and "Load
   * older mail" added fifty unread letters headed by the mailbox's newest INBOX letter, their first
   * fourteen senders exactly the fourteen the Screener lists as waiting. The server's page is the
   * INBOX folder; the Ohbox is a presentation of it, and a held stranger's letter is not in it.
   */
  it("a first-time sender's letters the Screener holds never enter Older, nor a dormant stranger's", async () => {
    const dormant: Row = { id: "00000000-0000-4000-8000-0000000000b1", date: "2025-04-01T09:00:00.000Z", from: "gone@example.invalid" };
    store.rows = [...HELD, dormant, ...OLDER];
    const el = await mountSettled();
    // The stranger's newest letter is the Screener's, not the Ohbox's.
    expect(listed(el)).not.toContain("m5");

    await pressLoadOlder(el);

    const shown = olderRows(el);
    for (const m of [...HELD, dormant]) {
      expect(shown, `${m.id} is not the Ohbox's mail, and Older listed it`).not.toContain(m.id);
    }
    // The positive control: the decided sender's older mail still arrives, in the same press.
    expect(shown.length, "the press listed nothing").toBeGreaterThan(0);
    for (const id of shown) expect(OLDER.map((m) => m.id)).toContain(id);
  }, 30_000);
});
