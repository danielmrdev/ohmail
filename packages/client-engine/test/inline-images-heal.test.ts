import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OhmailEngine, INLINE_IMAGE_MAX_BYTES } from "../src/engine.js";
import { REASK_MAX } from "../src/session-reask.js";
import { MutationRejectedError } from "../src/types.js";
import type { AttachmentWire, EngineAdapter } from "../src/adapters/adapter.js";

/**
 * a short drop while a letter opened left its inline picture missing until the
 * letter was reopened, while the file card beside it healed. A transient failure never becomes a
 * permanent missing picture: the part retries on the card's terms (the wire classifier, a drain
 * completing, at most REASK_MAX per episode), and a list or part that answers later — a re-ask or
 * a press — puts the picture in place without the document asking again.
 */

beforeEach(() => {
  let n = 0;
  (globalThis as { URL: unknown }).URL = {
    createObjectURL: () => `blob:${++n}`,
    revokeObjectURL: () => {},
  };
});
afterEach(() => {
  delete (globalThis as { URL?: unknown }).URL;
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const offline = () => new MutationRejectedError("network failure: TypeError: Failed to fetch", { code: "network", retryable: true });
const fault = () => new MutationRejectedError("boom", { status: 500, code: "internal", retryable: true });

function wire(o: Partial<AttachmentWire> = {}): AttachmentWire {
  return {
    id: o.id ?? "a1",
    filename: o.filename ?? "logo.png",
    contentType: o.contentType ?? "image/png",
    sizeBytes: o.sizeBytes ?? PNG.length,
    inline: o.inline ?? true,
    contentId: o.contentId === undefined ? "logo@corp" : o.contentId,
    messageId: "m1",
  };
}

/** An engine whose list and part fetches fail while `down` answers true for them. */
function rig(parts: AttachmentWire[], down: { list?: () => Error | null; part?: (id: string) => Error | null } = {}) {
  const calls = { list: 0, part: [] as string[] };
  const adapter: EngineAdapter = {
    sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async () => {
      calls.list += 1;
      const err = down.list?.() ?? null;
      if (err) throw err;
      return parts;
    },
    fetchAttachment: async (id: string) => {
      calls.part.push(id);
      const err = down.part?.(id) ?? null;
      if (err) throw err;
      return new Blob([PNG], { type: "image/png" });
    },
  };
  return { engine: new OhmailEngine({ adapter }), calls };
}

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const drain = async (engine: OhmailEngine) => { await engine.syncOnce(); await settle(); };

describe("an inline picture heals after a transient failure", () => {
  it("a part the wire failed is fetched again when a drain completes, and drawn in place", async () => {
    let up = false;
    const { engine, calls } = rig([wire()], { part: () => (up ? null : offline()) });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    expect(engine.inlineImagesOf("m1").size).toBe(0);
    up = true;
    await drain(engine);
    expect(calls.part).toEqual(["a1", "a1"]);
    expect(engine.inlineImagesOf("m1").has("logo@corp")).toBe(true);
  });

  it("a list the wire failed, re-asked by the surface, draws the picture without a second ask from the document", async () => {
    let up = false;
    const { engine, calls } = rig([wire()], { list: () => (up ? null : offline()) });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    expect(engine.inlineImagesOf("m1").size).toBe(0);
    up = true;
    await engine.reaskAttachments("m1");
    await settle();
    expect(calls.list).toBe(2);
    expect(engine.inlineImagesOf("m1").has("logo@corp")).toBe(true);
  });

  it("a press on the failed card that fetches the bytes draws the picture in the text too", async () => {
    // A fault the server answered: no automatic re-ask, so only the person's press heals it.
    let up = false;
    const { engine, calls } = rig([wire()], { part: () => (up ? null : fault()) });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    await drain(engine);
    expect(calls.part, "an answered fault is not asked again automatically").toEqual(["a1"]);
    up = true;
    await engine.openAttachment("m1", "a1", { retry: true });
    await settle();
    expect(engine.inlineImagesOf("m1").has("logo@corp")).toBe(true);
  });

  it("a press that lands while a pass is still walking the letter's other pictures draws too", async () => {
    let releaseB: () => void = () => {};
    const slowB = new Promise<void>((r) => { releaseB = r; });
    let upA = false;
    const calls: string[] = [];
    const engine = new OhmailEngine({
      adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }) as never,
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => null,
        listAttachments: async () => [wire({ id: "a", contentId: "a@corp" }), wire({ id: "b", contentId: "b@corp" })],
        fetchAttachment: async (id: string) => {
          calls.push(id);
          if (id === "a" && !upA) throw fault();
          if (id === "b") await slowB;
          return new Blob([PNG], { type: "image/png" });
        },
      },
    });
    const pass = engine.loadInlineImages("m1", ["a@corp", "b@corp"]);
    await settle();
    expect(calls, "the pass is waiting on b, a already failed").toEqual(["a", "b"]);
    upA = true;
    await engine.openAttachment("m1", "a", { retry: true });
    releaseB();
    await pass;
    await settle();
    expect([...engine.inlineImagesOf("m1").keys()].sort()).toEqual(["a@corp", "b@corp"]);
  });

  it("a drain while a pass is still walking spends no re-ask: the part is asked once the pass ends", async () => {
    let releaseB: () => void = () => {};
    const slowB = new Promise<void>((r) => { releaseB = r; });
    let upA = false;
    const calls: string[] = [];
    const engine = new OhmailEngine({
      adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }) as never,
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => null,
        listAttachments: async () => [wire({ id: "a", contentId: "a@corp" }), wire({ id: "b", contentId: "b@corp" })],
        fetchAttachment: async (id: string) => {
          calls.push(id);
          if (id === "a" && !upA) throw offline();
          if (id === "b") await slowB;
          return new Blob([PNG], { type: "image/png" });
        },
      },
    });
    const pass = engine.loadInlineImages("m1", ["a@corp", "b@corp"]);
    await settle();
    for (let i = 0; i < REASK_MAX; i++) await drain(engine);
    upA = true;
    releaseB();
    await pass;
    await drain(engine);
    expect(calls).toEqual(["a", "b", "a"]);
    expect([...engine.inlineImagesOf("m1").keys()].sort()).toEqual(["a@corp", "b@corp"]);
  });

  it(`asks at most ${REASK_MAX} times while the wire keeps failing`, async () => {
    const { engine, calls } = rig([wire()], { part: () => offline() });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    for (let i = 0; i < REASK_MAX + 2; i++) await drain(engine);
    expect(calls.part.length).toBe(1 + REASK_MAX);
  });

  it("control: a cid no part carries asks nothing on any drain, and stays absent", async () => {
    const { engine, calls } = rig([wire({ contentId: "other@corp" })], { part: () => offline() });
    await engine.loadInlineImages("m1", ["missing@corp"]);
    await drain(engine);
    await drain(engine);
    expect(calls.part).toEqual([]);
    expect(engine.inlineImagesOf("m1").size).toBe(0);
  });

  it("control: a picture over the ceiling is never fetched, on the first ask or a heal", async () => {
    let up = false;
    const { engine, calls } = rig(
      [wire({ id: "big", contentId: "big@corp", sizeBytes: INLINE_IMAGE_MAX_BYTES + 1 })],
      { list: () => (up ? null : offline()) },
    );
    await engine.loadInlineImages("m1", ["big@corp"]);
    up = true;
    await engine.reaskAttachments("m1");
    await settle();
    await drain(engine);
    expect(calls.part).toEqual([]);
  });

  it("control: a reader that left lets the picture go — no re-ask after the release", async () => {
    let up = false;
    const { engine, calls } = rig([wire()], { part: () => (up ? null : offline()) });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    engine.releaseAttachments("m1");
    up = true;
    await drain(engine);
    await engine.loadAttachments("m1");
    await settle();
    expect(calls.part).toEqual(["a1"]);
    expect(engine.inlineImagesOf("m1").size).toBe(0);
  });

  it("control: a reader that left over an answered refusal lets the picture go — a later Retry fetches no picture", async () => {
    let up = false;
    const { engine, calls } = rig([wire()], { list: () => (up ? null : fault()) });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    engine.releaseAttachments("m1", { keepFailure: true });
    up = true;
    await engine.loadAttachments("m1", { retry: true });
    await settle();
    expect(engine.attachmentsOf("m1").state).toBe("ready");
    expect(calls.part).toEqual([]);
  });

  it("control: a picture that arrived first time is fetched once, however many drains follow", async () => {
    const { engine, calls } = rig([wire()]);
    await engine.loadInlineImages("m1", ["logo@corp"]);
    await drain(engine);
    await drain(engine);
    expect(calls.part).toEqual(["a1"]);
    expect(engine.inlineImagesOf("m1").has("logo@corp")).toBe(true);
  });
});
