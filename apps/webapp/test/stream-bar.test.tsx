/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import type { StreamHandle } from "../app/shell/StreamShell";
import { useStreamBar, type StreamBar } from "../app/shell/stream-bar";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/* @reads: apps/webapp/app/views/ReadsView.tsx apps/webapp/app/views/ReceiptsView.tsx
   Read as text by paths built at runtime, so no landing pass selects this file when a view moves. */

/**
 * THE VERB BAR NEVER LEAVES A CARD THE READER CAN SEE.
 *
 * The stream mounts one bar, on the card opened last. Opening B while an earlier-opened A is still
 * on screen took A's bar in the same commit, A shrank by the bar's height, and either A or B moved
 * under the reader by 43–78px (measured by a browser rig, 21–23 of
 * 30 presses when the reader leaves what she read open). The bar now waits until A is out of the
 * port; a close takes it at once. A fake handle stands in for the stream's geometry.
 */
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let roots: Root[] = [];
afterEach(async () => {
  for (const r of roots) await act(() => { r.unmount(); });
  roots = [];
});

async function mountBar(onHolder?: (id: string | null) => void) {
  const onScreen = new Set<string>();
  const waiting = new Map<string, () => void>();
  const handle = {
    onScreen: (id: string) => onScreen.has(id),
    whenOffScreen: (id: string, cb: () => void) => { waiting.set(id, cb); },
  } as unknown as StreamHandle;
  let bar!: StreamBar;
  function Probe() {
    bar = useStreamBar(React.useRef<StreamHandle | null>(handle), onHolder);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  await act(() => { root.render(React.createElement(Probe)); });
  return {
    onScreen,
    has: (id: string) => bar.hasBar(id),
    async toggle(id: string, open: boolean) { await act(() => { bar.toggled(id, open); }); },
    /** The stream reports the card has left the port. */
    async leave(id: string) {
      onScreen.delete(id);
      const cb = waiting.get(id);
      waiting.delete(id);
      await act(() => { cb?.(); });
    },
  };
}

describe("useStreamBar", () => {
  it("opening B while A is on screen leaves A its bar until A is out of the port", async () => {
    const b = await mountBar();
    await b.toggle("A", true);
    expect(b.has("A")).toBe(true);
    b.onScreen.add("A");
    await b.toggle("B", true);
    expect(b.has("B"), "the card just opened carries the bar").toBe(true);
    expect(b.has("A"), "A is still on screen, so its bar stays").toBe(true);
    await b.leave("A");
    expect(b.has("A"), "off screen, the bar goes — where nobody sees the height change").toBe(false);
    expect(b.has("B")).toBe(true);
  });

  it("opening B while A is off screen takes A's bar at once — one bar at rest", async () => {
    const b = await mountBar();
    await b.toggle("A", true);
    await b.toggle("B", true);
    expect(b.has("A")).toBe(false);
    expect(b.has("B")).toBe(true);
  });

  it("a close takes the closed card's bar at once, lingering or not", async () => {
    const b = await mountBar();
    await b.toggle("A", true);
    b.onScreen.add("A");
    await b.toggle("B", true);
    expect(b.has("A")).toBe(true);
    await b.toggle("A", false);
    expect(b.has("A"), "the reader's own close on A").toBe(false);
    expect(b.has("B"), "and it never strips B's").toBe(true);
    await b.toggle("B", false);
    expect(b.has("B")).toBe(false);
  });
});

describe("the card with the bar is the stream's open reading", () => {
  /** What the address names (`reportPick`): the card opened last, until its own close. */
  it("the card opened last is reported, and its close reports none", async () => {
    const heard: Array<string | null> = [];
    const b = await mountBar((id) => heard.push(id));
    await b.toggle("A", true);
    await b.toggle("B", true);
    expect(heard.at(-1), "the card opened last").toBe("B");
    await b.toggle("A", false);
    expect(heard.at(-1), "closing another card moves nothing").toBe("B");
    await b.toggle("B", false);
    expect(heard.at(-1), "the reading closed").toBeNull();
  });
});

describe("both reading streams draw the bar from it", () => {
  const ROOT = join(__dirname, "..");
  for (const view of ["ReadsView", "ReceiptsView"]) {
    it(`${view} passes the hook's answer as the card's \`expanded\``, () => {
      const code = withoutComments(readFileSync(join(ROOT, "app", "views", `${view}.tsx`), "utf8"));
      expect(code).toMatch(/const bar = useStreamBar\(streamRef, onPick\);/);
      expect(code).toMatch(/expanded=\{bar\.hasBar\(m\.id\)\}/);
      expect(code).toMatch(/barToggled\(id, open\);/);
      expect(code, "no second owner of the bar").not.toMatch(/setExpandedId/);
    });
  }
});
