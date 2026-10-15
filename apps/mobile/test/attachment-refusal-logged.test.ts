/**
 * ═══ A PRESS THAT ANSWERED NOTHING WRITES ONE LINE ═══════════════════════════════════════════
 *
 * Measured on the Android live-mailbox rig (2026-09-20): on the standalone door the tile
 * answered "Couldn't open this file." and the cid picture drew blank, and `adb logcat -s
 * ReactNativeJS` carried NOTHING for either — every other engine line arrived. That silence is
 * what let a byte-path defect survive a fix proven on the other door, so the line is part of the
 * fix. It is not a second logger: the whole line is derived from a member of one closed union,
 * so there is nothing about a message, a sender or a file in it to redact — this file pins that
 * by reading every key off the emitted JSON.
 *
 * The engine here is a DOUBLE only for the state it is in (`ready` / `failed` / `too_large` are
 * the engine's own item states, and `attachmentsOf` / `attachmentBlobOf` its own reads); the
 * code under test is the app's real `openAttachmentBytes` and `loadInlineImages`.
 *
 * MUTATIONS WATCHED (parked and restored through `mutation-control.sh`): each
 * `logAttachmentRefusal` call in `live.ts` removed alone ⇒ its own arm RED.
 */
import { describe, expect, it, vi } from "vitest";

import { logAttachmentRefusal, type AttachmentRefusal } from "../src/engine/engine-log";
import { liveActions, type LiveWorldActions } from "../src/state/live";

/** Every `console.log` line the body wrote, parsed. */
async function linesOf(body: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const written: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { written.push(String(a[0])); });
  try {
    await body();
  } finally {
    spy.mockRestore();
  }
  return written.map((l) => JSON.parse(l) as Record<string, unknown>);
}

interface ItemState {
  state: "ready" | "failed" | "too_large";
  blob?: Blob;
}

function actionsOver(opts: {
  item?: ItemState;
  inline?: ReadonlyMap<string, string>;
}): LiveWorldActions {
  const item = opts.item;
  const engine = {
    openAttachment: async () => undefined,
    attachmentsOf: () => (item
      ? { state: "ready" as const, items: [{ id: "a1", state: item.state, mimeType: "application/pdf", filename: "invoice.pdf" }] }
      : { state: "ready" as const, items: [] }),
    attachmentBlobOf: () => item?.blob,
    loadInlineImages: async () => undefined,
    inlineImagesOf: () => opts.inline ?? new Map<string, string>(),
  };
  return liveActions({
    engine: engine as never,
    toast: () => undefined,
    uuid: () => "00000000-0000-4000-8000-000000000001",
    zone: "UTC",
  });
}

describe("the line is closed by construction", () => {
  it("carries exactly service, event and the reason — and nothing else", async () => {
    const lines = await linesOf(async () => { logAttachmentRefusal("bytes_failed"); });
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]!).sort()).toEqual(["event", "reason", "service"]);
    expect(lines[0]).toEqual({ service: "app", event: "attachment_refused", reason: "bytes_failed" });
  });

  it("writes each of the four reasons verbatim", async () => {
    const reasons: AttachmentRefusal[] = ["bytes_unavailable", "bytes_failed", "bytes_unreadable", "inline_images_none"];
    const lines = await linesOf(async () => { for (const r of reasons) logAttachmentRefusal(r); });
    expect(lines.map((l) => l.reason)).toEqual(reasons);
  });
});

describe("the tile press", () => {
  it("a refused byte read is no longer silent", async () => {
    const actions = actionsOver({ item: { state: "failed" } });
    let answer: unknown;
    const lines = await linesOf(async () => { answer = await actions.openAttachmentBytes("m1", "a1"); });
    expect(answer).toEqual({ state: "failed", code: null, retryable: true, status: null });
    expect(lines.map((l) => l.reason)).toEqual(["bytes_failed"]);
  });

  it("a part the list never carried says so with its own reason", async () => {
    const actions = actionsOver({});
    let answer: unknown;
    const lines = await linesOf(async () => { answer = await actions.openAttachmentBytes("m1", "a1"); });
    expect(answer).toEqual({ state: "unavailable" });
    expect(lines.map((l) => l.reason)).toEqual(["bytes_unavailable"]);
  });

  it("bytes in hand that this device cannot read are told apart from a refused fetch", async () => {
    const unreadable = { size: 3, type: "application/pdf", arrayBuffer: async () => { throw new Error("blob read failed"); } };
    const actions = actionsOver({ item: { state: "ready", blob: unreadable as unknown as Blob } });
    let answer: unknown;
    const lines = await linesOf(async () => { answer = await actions.openAttachmentBytes("m1", "a1"); });
    expect(answer).toEqual({ state: "failed", code: "bytes_unreadable", retryable: true, status: null });
    expect(lines.map((l) => l.reason)).toEqual(["bytes_unreadable"]);
  });

  it("the size ceiling is an ANSWER, not a refusal, and writes nothing", async () => {
    const actions = actionsOver({ item: { state: "too_large" } });
    let answer: unknown;
    const lines = await linesOf(async () => { answer = await actions.openAttachmentBytes("m1", "a1"); });
    expect(answer).toEqual({ state: "too_large" });
    expect(lines).toEqual([]);
  });

  it("bytes that arrive write nothing at all", async () => {
    const good = { size: 3, type: "application/pdf", arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    const actions = actionsOver({ item: { state: "ready", blob: good as unknown as Blob } });
    const lines = await linesOf(async () => { await actions.openAttachmentBytes("m1", "a1"); });
    expect(lines).toEqual([]);
  });
});

describe("the embedded pictures pass", () => {
  it("a document that asked for pictures and got none says so", async () => {
    const actions = actionsOver({ inline: new Map() });
    const lines = await linesOf(async () => {
      actions.loadInlineImages("m1", ["cid-1"]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(lines.map((l) => l.reason)).toEqual(["inline_images_none"]);
  });

  it("a picture that drew writes nothing", async () => {
    const actions = actionsOver({ inline: new Map([["cid-1", "data:image/png;base64,AA"]]) });
    const lines = await linesOf(async () => {
      actions.loadInlineImages("m1", ["cid-1"]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(lines).toEqual([]);
  });
});
