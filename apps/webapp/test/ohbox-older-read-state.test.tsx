/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, teardownShellEnv, tick } from "./fixtures/live-walk-shell";
import { OLDER, installOlderStore, mountSettled, olderRows, pressLoadOlder, store } from "./fixtures/older-store-shell";

/**
 * an Older row marked read stayed unread on screen.
 *
 * The server marked the three rows read within ten seconds; a minute later they still showed
 * unread. The fetched copy was a snapshot no verb could compute an effect over, and the store's
 * word on it (a drain carrying the read row) landed in a mirror whose window pruned it again.
 * The window here is five rows, so the drain's row is pruned as a full tab's window prunes it.
 */

beforeEach(installOlderStore);
afterEach(teardownShellEnv);

const SMALL = { days: 90, minRows: 5, maxRows: 6 };
const seen = (el: HTMLElement, id: string): boolean =>
  el.querySelector(`.row[data-id="${id}"]`)?.classList.contains("seen") ?? false;
const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await tick(0);
};

describe("an Older row's read state follows the press and the store", () => {
  it("reads at the press, and still reads after the store's word is pruned", async () => {
    store.rows = OLDER;
    const el = await mountSettled({ window: SMALL });
    await pressLoadOlder(el);
    const id = OLDER[0]!.id; // unread in the store
    expect(olderRows(el)).toContain(id);
    expect(seen(el, id), "the fixture's Older row is not unread").toBe(false);

    await act(async () => { el.querySelector<HTMLElement>(`.row[data-id="${id}"]`)!.click(); });
    await key("x");
    await key("U", { shiftKey: true });

    // The verb's own result, the way an in-window row flips at the press.
    expect(seen(el, id), "the press left the Older row unread").toBe(true);
    // The store's word lands on the next drain and the window prunes the row again at the settle.
    await tick(30_000);
    expect(store.writes.some((w) => w.method === "PATCH"), "the read never reached the store").toBe(true);
    expect(seen(el, id), "the row read unread again once the window pruned the store's word").toBe(true);
  }, 60_000);
});
