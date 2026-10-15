import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { accountSettings, trackerEvents } from "@trafficflow/db";
import { imageDimensions } from "@trafficflow/core/image-dimensions";
import * as F from "../../core/test/fixtures/images.js";
import { makeDeps, seedSession, seedMessage, seedBody, req, FIXED_NOW } from "./helpers.js";

/* @reads: packages/api/src/routes/privacy.ts
   Reads the route's allow-list by a path built at runtime, so the table below follows it. */

/**
 * EVERY TYPE `GET /img` SERVES IS SIZED, SO A 1×1 IN ANY OF THEM IS A PIXEL. The route's allow-list
 * is read from its own source and each label is driven through the real route with real encoder
 * output: a 2×3 is relayed byte for byte, a 1×1 is the transparent stub with a `pixel` row. What
 * cannot be sized is refused, whatever the pixel switch says.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/** Every label the route admits, and a family fixture pair for it. */
const LABELS: [label: string, one: Uint8Array, twoByThree: Uint8Array][] = [
  ["image/gif", F.GIF_1X1, F.GIF_2X3],
  ["image/png", F.PNG_1X1, F.PNG_2X3],
  ["image/apng", F.APNG_1X1, F.APNG_2X3],
  ["image/jpeg", F.JPEG_PROGRESSIVE_1X1, F.JPEG_EXIF_2X3],
  ["image/webp", F.WEBP_VP8_1X1, F.WEBP_VP8X_2X3],
  ["image/avif", F.AVIF_1X1, F.AVIF_2X3],
  ["image/bmp", F.BMP_1X1, F.BMP_2X3],
  ["image/x-icon", F.ICO_1X1, F.ICO_1X1_AND_16X16],
  ["image/vnd.microsoft.icon", F.ICO_1X1, F.ICO_2X3],
];

/** The route's own allow-list, read from its source: a label added there must be added here. */
function admittedLabels(): string[] {
  const src = readFileSync(new URL("../src/routes/privacy.ts", import.meta.url), "utf8");
  const m = /const PROXIED_IMAGE_TYPES: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  return m ? [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!) : [];
}

async function proxied(label: string, body: Uint8Array, opts: { pixels?: boolean } = {}) {
  const { db, deps } = await makeDeps(FIXED_NOW, {}, {
    remote: { async fetch() { return { status: 200, contentType: label, body }; } },
  });
  const s = await seedSession(db, { now: FIXED_NOW });
  const { id } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
  await seedBody(db, { messageId: id, html: "<img>", loadedRemoteContent: true });
  if (opts.pixels) await db.insert(accountSettings).values({ accountId: s.accountId, loadTrackingPixelsAt: new Date() });
  const u = encodeURIComponent("https://images.acme-cdn.com/hero");
  const res = await H(req("GET", `/img?mid=${id}&u=${u}`, { bearer: s.token }), deps);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const rows = await db.select().from(trackerEvents).where(eq(trackerEvents.messageId, id));
  return { status: res.status, type: res.headers.get("content-type"), bytes, kinds: rows.map((r) => r.kind) };
}

describe("GET /img sizes every type it serves", () => {
  it("the table covers the route's allow-list exactly", () => {
    const admitted = admittedLabels();
    expect(admitted.length, "the allow-list did not parse").toBeGreaterThan(5);
    expect(LABELS.map((l) => l[0]).sort()).toEqual([...admitted].sort());
  });

  it.each(LABELS)("%s: a 2×3 is relayed as it came, with no event", async (label, _one, twoByThree) => {
    const r = await proxied(label, twoByThree);
    expect({ status: r.status, type: r.type, kinds: r.kinds }).toEqual({ status: 200, type: label, kinds: [] });
    expect(r.bytes).toEqual(twoByThree);
  });

  it.each(LABELS)("%s: a 1×1 is the stub, recorded as a pixel", async (label, one) => {
    const r = await proxied(label, one);
    expect({ status: r.status, type: r.type, kinds: r.kinds }).toEqual({ status: 200, type: "image/gif", kinds: ["pixel"] });
    expect(r.bytes.byteLength).toBe(43);
    expect(imageDimensions(r.bytes)).toEqual({ w: 1, h: 1 });
  });
});

describe("the size a browser draws, whatever else the file carries", () => {
  const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const box = (type: string, ...payload: number[][]): number[] => {
    const body = payload.flat();
    return [...u32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body];
  };

  it("an AVIF whose primary item is 1×1 is the pixel, though a track appended after it claims 2×3", async () => {
    const tkhd = box("tkhd", [0, 0, 0, 3], new Array<number>(72).fill(0), u32(2 << 16), u32(3 << 16));
    const r = await proxied("image/avif", Uint8Array.from([...F.AVIF_1X1, ...box("moov", box("trak", tkhd))]));
    expect({ status: r.status, type: r.type, kinds: r.kinds }).toEqual({ status: 200, type: "image/gif", kinds: ["pixel"] });
  });

  it("a JPEG with stray bytes between its header segments is relayed as it came, not refused", async () => {
    const at = F.JPEG_2X3.findIndex((x, i) => x === 0xff && F.JPEG_2X3[i + 1] === 0xdb);
    const junk = Uint8Array.from([...F.JPEG_2X3.subarray(0, at), 0x00, 0x00, ...F.JPEG_2X3.subarray(at)]);
    const r = await proxied("image/jpeg", junk);
    expect({ status: r.status, type: r.type, kinds: r.kinds }).toEqual({ status: 200, type: "image/jpeg", kinds: [] });
    expect(r.bytes).toEqual(junk);
  });
});

describe("what cannot be sized is refused", () => {
  it.each([
    ["TIFF bytes under an admitted label", "image/png", F.TIFF_2X3],
    ["a PNG cut at 20 bytes", "image/png", F.PNG_2X3.subarray(0, 20)],
    ["SVG bytes under the SVG label", "image/svg+xml", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ])("%s: 424, nothing relayed, nothing recorded", async (_l, label, body) => {
    const r = await proxied(label, body);
    expect({ status: r.status, kinds: r.kinds }).toEqual({ status: 424, kinds: [] });
    expect(JSON.parse(new TextDecoder().decode(r.bytes)).error.code).toBe("upstream_failed");
  });

  it("the refusal does not hang on the pixel switch: with pixels loading, a 1×1 answers and the unsized is still refused", async () => {
    const one = await proxied("image/webp", F.WEBP_VP8L_1X1, { pixels: true });
    expect({ status: one.status, kinds: one.kinds }).toEqual({ status: 200, kinds: ["pixel"] });
    const tiff = await proxied("image/png", F.TIFF_2X3, { pixels: true });
    expect({ status: tiff.status, kinds: tiff.kinds }).toEqual({ status: 424, kinds: [] });
  });
});
