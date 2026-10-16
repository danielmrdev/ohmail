/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MessageRow } from "@ohmail/ui";

/**
 * ── THE PAPERCLIP IS PAINTED FROM `hasAttachment`, AND FROM NOTHING ELSE ────────────────────
 *
 * The end of the chain the mime tests start: `normalizeMime` sets `hasAttachments` from
 * "is there a downloadable file" (`isRealFile` — inline/cid parts excluded), the views pass
 * `m.hasAttachments` into this prop, and THIS is the pixel it becomes. The mime suite proves an
 * inline-only message carries `false` and a message with a real PDF carries `true`; this file
 * proves each value draws what it claims, so between the two, "a signature logo raises no
 * paperclip, an invoice does" is checked at both ends rather than assumed in the middle.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function renderRow(hasAttachment: boolean | undefined): Promise<HTMLDivElement> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(MessageRow, {
        id: "m1",
        from: "Anna Example",
        subject: "With my signature",
        ...(hasAttachment === undefined ? {} : { hasAttachment }),
      }),
    );
  });
  return host;
}
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

/** The clip icon, found by its own path data — the only clip-shaped thing in a row. */
const clip = (): Element | null => host!.querySelector('svg path[d^="M10.6 5.1"]');

describe("MessageRow — the attachment indicator", () => {
  it("a row with a real file shows the clip", async () => {
    await renderRow(true);
    expect(clip(), "hasAttachment: true must draw the paperclip badge").not.toBeNull();
  });

  it("a row without one shows none — an inline-only message reaches here as `false`", async () => {
    await renderRow(false);
    expect(clip()).toBeNull();
    await renderRow(undefined);
    expect(clip()).toBeNull();
  });
});
