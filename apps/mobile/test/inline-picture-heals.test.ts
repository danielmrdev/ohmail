/**
 * the phone's reader. A drop while a letter opened left its file list failed and its
 * embedded picture blank until the reader left and came back: nothing on the phone asked a list
 * again. The facade's held lists now take the web's door (`watchLists`): a list the wire failed is
 * asked again on a completed drain, and the picture the document asked for draws when it answers.
 * Driven through the app's real `liveActions` over a real engine; only the server is a double.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MutationRejectedError, OhmailEngine, type EngineAdapter } from "@ohmail/client-engine";

import { liveActions } from "../src/state/live";

beforeEach(() => {
  (globalThis as { URL: unknown }).URL = { createObjectURL: () => "blob:1", revokeObjectURL: () => {} };
});
afterEach(() => {
  delete (globalThis as { URL?: unknown }).URL;
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const offline = () => new MutationRejectedError("network failure: TypeError: Failed to fetch", { code: "network", retryable: true });
const part = { id: "a1", filename: "logo.png", contentType: "image/png", sizeBytes: PNG.length, inline: true, contentId: "logo@corp", messageId: "m1" };

function rig(down: () => boolean) {
  const asked = { list: 0 };
  const engine = new OhmailEngine({
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }) as never,
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
      listAttachments: async () => {
        asked.list += 1;
        if (down()) throw offline();
        return [part];
      },
      fetchAttachment: async () => new Blob([PNG], { type: "image/png" }),
    } as EngineAdapter,
  });
  const acts = liveActions({ engine, toast: () => undefined, uuid: () => "00000000-0000-4000-8000-000000000001", zone: "UTC" });
  return { engine, acts, asked };
}

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe("the phone's reader heals a letter's picture after a short drop", () => {
  it("a held list the wire failed is asked again on a drain, and the picture draws", async () => {
    let down = true;
    const { engine, acts, asked } = rig(() => down);
    const stop = acts.watchLists();
    acts.holdFiles(["m1"]);
    await settle();
    acts.loadInlineImages("m1", ["logo@corp"]);
    await settle();
    expect(engine.attachmentsOf("m1").state).toBe("failed");
    expect(engine.inlineImagesOf("m1").size).toBe(0);
    down = false;
    await engine.syncOnce();
    await settle();
    stop();
    expect(asked.list).toBe(2);
    expect(engine.inlineImagesOf("m1").has("logo@corp")).toBe(true);
  });

  it("control: a list nobody holds is not asked again", async () => {
    let down = true;
    const { engine, acts, asked } = rig(() => down);
    const stop = acts.watchLists();
    await engine.loadAttachments("m1");
    down = false;
    await engine.syncOnce();
    await settle();
    stop();
    expect(asked.list).toBe(1);
  });
});
