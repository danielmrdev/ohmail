/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, teardownShellEnv, tick } from "./fixtures/live-walk-shell";
import {
  OLDER, installOlderStore, listed, mountSettled, olderRows, pressLoadOlder, store,
} from "./fixtures/older-store-shell";

/**
 * AN OLDER ROW CAN BE DRAGGED TO THE RAIL, like every row above it.
 *
 * A row "Load older mail" fetched could be selected, opened, picked and acted on, and not dragged:
 * the gesture resolved its source through the three groups, which answer nothing for it, so the
 * press never became a drag and the drop never reached the verb.
 *
 * Pointer events are MouseEvents named as pointer events (jsdom has no PointerEvent), and
 * `elementFromPoint` answers the rail row the pointer is "over" — `drag-file.test.tsx`'s shape.
 */

beforeEach(installOlderStore);
afterEach(async () => {
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  await teardownShellEnv();
});

const pointer = async (type: string, target: EventTarget, x: number, y: number): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
};
const hovering = (el: Element | null): void => {
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => el;
};

describe("dragging an Older row", () => {
  it("files it on the rail target it is dropped on", async () => {
    store.rows = OLDER;
    const el = await mountSettled();
    await pressLoadOlder(el);
    const id = OLDER[1]!.id;
    expect(olderRows(el)).toContain(id);
    store.writes = [];

    const row = el.querySelector<HTMLElement>(`.row[data-id="${id}"]`)!;
    const news = el.querySelector<HTMLElement>('[data-rail-id="reads"]');
    await pointer("pointerdown", row, 10, 10);
    hovering(news);
    await pointer("pointermove", window, 60, 60);
    // MUTATION: `dragSourceFor` back to the three groups — no ghost, and nothing is filed.
    expect(document.body.querySelector(".drag-ghost"), "the Older row never became a drag").toBeTruthy();
    await pointer("pointerup", window, 60, 60);
    await tick(600);

    expect(store.writes.some((w) => w.method === "POST" && w.url.includes(`/messages/${id}/move`)),
      "the drop filed nothing").toBe(true);
  }, 30_000);

  it("a row above the tail still drags as before (the control)", async () => {
    store.rows = OLDER;
    const el = await mountSettled();
    await pressLoadOlder(el);
    const above = listed(el).find((x) => !olderRows(el).includes(x))!;
    const row = el.querySelector<HTMLElement>(`.row[data-id="${above}"]`)!;
    await pointer("pointerdown", row, 10, 10);
    hovering(el.querySelector('[data-rail-id="reads"]'));
    await pointer("pointermove", window, 60, 60);
    expect(document.body.querySelector(".drag-ghost")).toBeTruthy();
    await pointer("pointerup", window, 60, 60);
    await tick(600);
  }, 30_000);
});
