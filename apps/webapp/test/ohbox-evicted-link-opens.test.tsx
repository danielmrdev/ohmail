/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { teardownShellEnv, textOf } from "./fixtures/live-walk-shell";
import { OLDER, installOlderStore, mountSettled, store } from "./fixtures/older-store-shell";

/**
 * A LINK TO MAIL THE WINDOW EVICTED OPENS — the store is asked for the one message by id.
 *
 * The open message lives in the URL, so a reload, a copied link or a restored tab names an id.
 * When the mirror no longer held it (the window had evicted it), the route mirror waited for the
 * drain, found nothing, and dropped the id from the bar: the reader opened nothing and the link
 * was gone. No engine door fetched one message by id, though both hosts serve `GET /messages/:id`.
 */

beforeEach(installOlderStore);
afterEach(teardownShellEnv);

describe("an id the mirror does not hold is the store's to answer", () => {
  it("a routed link to an evicted message opens it, and the bar keeps the id", async () => {
    const target = OLDER[1]!;
    store.rows = OLDER;
    window.location.hash = `#/ohbox/m/${target.id}`;
    const el = await mountSettled();

    expect(store.byId, "the store was never asked for the message").toContain(target.id);
    expect(textOf(el), "the reader opened nothing on the link").toContain(`subject of ${target.id}`);
    expect(window.location.hash, "the link was dropped from the bar").toContain(target.id);
  }, 30_000);

  it("an id the store does not hold either is still dropped from the bar, as before", async () => {
    // The control: a link from another account's mirror, or to mail the server no longer has.
    store.rows = OLDER;
    const stranger = "00000000-0000-4000-8000-0000000000ff";
    window.location.hash = `#/ohbox/m/${stranger}`;
    await mountSettled();

    expect(store.byId).toContain(stranger);
    expect(window.location.hash).not.toContain(stranger);
  }, 30_000);
});
