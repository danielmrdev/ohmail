import { describe, it, expect } from "vitest";
import { imageDimensions } from "../src/image-dimensions.js";
import * as F from "./fixtures/images.js";

/**
 * EVERY FAMILY THE PROXY SERVES IS SIZED FROM ITS BYTES (DISGUISED-PIXEL-SIZE-READS-GIF-AND-PNG-ONLY).
 * The post-fetch 1×1 check read GIF and PNG, so a 1×1 JPEG, WebP, AVIF, BMP or ICO was drawn and
 * never recorded. Each family below is real encoder output; the decoys are the shapes a reader that
 * takes the first size it finds gets wrong; the unsized are what the proxy now refuses.
 */

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, ...payload: number[][]): number[] => {
  const body = payload.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
};
const full = (type: string, version: number, flags: number, ...payload: number[][]): number[] =>
  box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...payload);
const bytes = (...parts: number[][]): Uint8Array => Uint8Array.from(parts.flat());

/** A still AVIF whose FIRST `ispe` (item 1) is 2×3 and whose item 2 is 1×1; `primary` picks one. */
function avifTwoItems(primary: number | null): Uint8Array {
  const ipco = box("ipco", full("ispe", 0, 0, u32(2), u32(3)), full("ispe", 0, 0, u32(1), u32(1)));
  const ipma = full("ipma", 0, 0, u32(2), [0, 1, 1, 0x81], [0, 2, 1, 0x82]);
  const meta = full("meta", 0, 0, ...(primary === null ? [] : [full("pitm", 0, 0, [0, primary])]), box("iprp", ipco, ipma));
  return bytes(box("ftyp", ascii("avif"), u32(0), ascii("avif"), ascii("mif1")), meta);
}

/** A JPEG whose EXIF segment carries another whole JPEG as its thumbnail. */
function withThumbnail(main: Uint8Array, thumb: Uint8Array): Uint8Array {
  const app1 = [...ascii("Exif"), 0, 0, ...thumb];
  const len = app1.length + 2;
  return bytes([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255], app1, [...main.subarray(2)]);
}

const ftyp = (major: string, ...compatible: string[]): number[] => box("ftyp", ascii(major), u32(0), ...compatible.map(ascii));
const tkhd = (w: number, h: number): number[] => full("tkhd", 0, 3, new Array<number>(72).fill(0), u32(w << 16), u32(h << 16));
/** A track as a sequence carries one: its size, its sample entry, and an `auxl` reference if it is alpha. */
function trak(w: number, h: number, o: { entry?: string; alpha?: boolean } = {}): number[] {
  const stsd = full("stsd", 0, 0, u32(1), box(o.entry ?? "av01", new Array<number>(8).fill(0)));
  return box("trak", tkhd(w, h), ...(o.alpha ? [box("tref", box("auxl", u32(1)))] : []), box("mdia", box("minf", box("stbl", stsd))));
}
/** A `trak` that holds only a `tkhd`: a size with nothing a decoder reads behind it. */
const bareTrak = (w: number, h: number): number[] => box("trak", tkhd(w, h));
/** A still whose one item, the primary, is `w`×`h`, under any `ftyp`, with any boxes after it. */
function still(head: number[], w: number, h: number, ...after: number[][]): Uint8Array {
  const iprp = box("iprp", box("ipco", full("ispe", 0, 0, u32(w), u32(h))), full("ipma", 0, 0, u32(1), [0, 1, 1, 0x81]));
  return bytes(head, full("meta", 0, 0, full("pitm", 0, 0, [0, 1]), iprp), ...after);
}
/** `j` with `junk` inserted in front of its first DQT marker, between two header segments. */
function beforeDqt(j: Uint8Array, ...junk: number[]): Uint8Array {
  let at = -1;
  for (let i = 2; i + 1 < j.length && at < 0; i += 1) if (j[i] === 0xff && j[i + 1] === 0xdb) at = i;
  expect(at, "the fixture carries a DQT").toBeGreaterThan(2);
  return bytes([...j.subarray(0, at)], junk, [...j.subarray(at)]);
}

describe("imageDimensions — every family, from real encoder output", () => {
  it.each([
    ["GIF", F.GIF_1X1, F.GIF_2X3],
    ["PNG", F.PNG_1X1, F.PNG_2X3],
    ["APNG", F.APNG_1X1, F.APNG_2X3],
    ["JPEG baseline", F.JPEG_1X1, F.JPEG_2X3],
    ["JPEG progressive", F.JPEG_PROGRESSIVE_1X1, F.JPEG_PROGRESSIVE_2X3],
    ["JPEG with EXIF ahead of the frame", F.JPEG_EXIF_1X1, F.JPEG_EXIF_2X3],
    ["WebP lossy (VP8)", F.WEBP_VP8_1X1, F.WEBP_VP8_2X3],
    ["WebP lossless (VP8L)", F.WEBP_VP8L_1X1, F.WEBP_VP8L_2X3],
    ["WebP extended (VP8X)", F.WEBP_VP8X_1X1, F.WEBP_VP8X_2X3],
    ["AVIF", F.AVIF_1X1, F.AVIF_2X3],
    ["BMP", F.BMP_1X1, F.BMP_2X3],
    ["ICO", F.ICO_1X1, F.ICO_2X3],
  ])("%s: the 1×1 is 1×1 and the 2×3 is 2×3", (_family, one, twoByThree) => {
    expect(imageDimensions(one)).toEqual({ w: 1, h: 1 });
    expect(imageDimensions(twoByThree)).toEqual({ w: 2, h: 3 });
  });
});

describe("the decoys a first-size-found reader gets wrong", () => {
  it("an ICO is its largest entry, and a 0 in the directory is 256", () => {
    expect(imageDimensions(F.ICO_1X1_AND_16X16)).toEqual({ w: 16, h: 16 });
    const wide = Uint8Array.from(F.ICO_1X1);
    wide[6] = 0;
    wide[7] = 0;
    expect(imageDimensions(wide)).toEqual({ w: 256, h: 256 });
  });

  it("a JPEG is its own frame, never the thumbnail inside its EXIF", () => {
    expect(imageDimensions(withThumbnail(F.JPEG_1X1, F.JPEG_2X3))).toEqual({ w: 1, h: 1 });
    expect(imageDimensions(withThumbnail(F.JPEG_2X3, F.JPEG_1X1))).toEqual({ w: 2, h: 3 });
  });

  it("an AVIF is its PRIMARY item, not the first ispe in the file", () => {
    expect(imageDimensions(avifTwoItems(2))).toEqual({ w: 1, h: 1 });
    expect(imageDimensions(avifTwoItems(1))).toEqual({ w: 2, h: 3 });
    expect(imageDimensions(avifTwoItems(null)), "no primary item: nothing says which size is drawn").toBeNull();
  });

  it("a BMP with the core header, and a top-down BMP", () => {
    const core = bytes(ascii("BM"), [30, 0, 0, 0, 0, 0, 0, 0, 26, 0, 0, 0], [12, 0, 0, 0, 1, 0, 1, 0, 1, 0, 24, 0], [0, 0, 0, 0]);
    expect(imageDimensions(core)).toEqual({ w: 1, h: 1 });
    const topDown = Uint8Array.from(F.BMP_2X3);
    topDown.set([0xfd, 0xff, 0xff, 0xff], 22);
    expect(imageDimensions(topDown)).toEqual({ w: 2, h: 3 });
  });
});

describe("an AVIF is sized from the source a browser decodes, which its major brand names", () => {
  it("major brand avif is its primary item: a track after it never overrides it", () => {
    expect(imageDimensions(bytes([...F.AVIF_1X1], box("moov", bareTrak(2, 3)))), "a bare track appended to real output").toEqual({ w: 1, h: 1 });
    expect(imageDimensions(still(ftyp("avif", "avif", "mif1"), 1, 1, box("moov", trak(2, 3)))), "a colour track").toEqual({ w: 1, h: 1 });
    expect(imageDimensions(still(ftyp("avif", "avif", "mif1"), 2, 3, box("moov", trak(1, 1))))).toEqual({ w: 2, h: 3 });
  });

  it("major brand avis is its first colour track: an av01 sample entry, not the alpha track", () => {
    const seq = (...traks: number[][]): Uint8Array => bytes(ftyp("avis", "avis", "msf1", "avif", "mif1"), box("moov", ...traks));
    expect(imageDimensions(seq(trak(1, 1)))).toEqual({ w: 1, h: 1 });
    expect(imageDimensions(seq(trak(2, 3), trak(1, 1)))).toEqual({ w: 2, h: 3 });
    expect(imageDimensions(seq(bareTrak(2, 3), trak(1, 1))), "a track with no sample entry").toEqual({ w: 1, h: 1 });
    expect(imageDimensions(seq(trak(2, 3, { entry: "mp4v" }), trak(1, 1))), "a track that is not AV1").toEqual({ w: 1, h: 1 });
    expect(imageDimensions(seq(trak(2, 3, { alpha: true }), trak(1, 1))), "the alpha track").toEqual({ w: 1, h: 1 });
    expect(imageDimensions(seq(bareTrak(2, 3))), "no colour track: nothing is decoded").toBeNull();
    const avis = ftyp("avis", "avis", "msf1", "avif", "mif1");
    expect(imageDimensions(still(avis, 2, 3, box("moov", bareTrak(1, 1)))), "a still item is not what avis decodes").toBeNull();
  });

  it("any other major brand is its colour track when it has one, else its primary item", () => {
    expect(imageDimensions(still(ftyp("mif1", "mif1", "avif"), 2, 3, box("moov", trak(1, 1))))).toEqual({ w: 1, h: 1 });
    expect(imageDimensions(still(ftyp("mif1", "mif1", "avif"), 1, 1, box("moov", bareTrak(2, 3))))).toEqual({ w: 1, h: 1 });
  });
});

describe("a JPEG's header is walked as the decoder walks it", () => {
  it("stray bytes before a marker are skipped: the picture a browser draws is sized", () => {
    expect(imageDimensions(beforeDqt(F.JPEG_2X3, 0x00, 0x00))).toEqual({ w: 2, h: 3 });
    expect(imageDimensions(beforeDqt(F.JPEG_1X1, 0x00, 0x00))).toEqual({ w: 1, h: 1 });
  });

  it("fill bytes are swallowed, and a stuffed FF00 is not a marker", () => {
    expect(imageDimensions(beforeDqt(F.JPEG_2X3, 0xff, 0xff))).toEqual({ w: 2, h: 3 });
    expect(imageDimensions(beforeDqt(F.JPEG_2X3, 0xff, 0x00))).toEqual({ w: 2, h: 3 });
  });

  it("a second SOI ends the walk, as it ends the decoder", () => {
    expect(imageDimensions(beforeDqt(F.JPEG_2X3, 0xff, 0xd8))).toBeNull();
  });
});

describe("what cannot be sized is null, and the proxy refuses it", () => {
  it.each([
    ["TIFF (no admitted family)", F.TIFF_2X3],
    ["a PNG cut at 20 bytes", F.PNG_2X3.subarray(0, 20)],
    ["a GIF cut at 8 bytes", F.GIF_2X3.subarray(0, 8)],
    ["HEIC, an ISOBMFF picture that is not AVIF", bytes(box("ftyp", ascii("heic"), u32(0), ascii("mif1"), ascii("heic")))],
    ["SVG text", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')],
    ["a JPEG whose scan starts before any frame header", bytes([0xff, 0xd8, 0xff, 0xda, 0, 8, 1, 2, 3, 4, 5, 6])],
    ["a WebP with an unknown first chunk", bytes(ascii("RIFF"), u32(0), ascii("WEBPXXXX"), new Array<number>(20).fill(0))],
    ["nothing", new Uint8Array(0)],
  ])("%s", (_label, body) => {
    expect(imageDimensions(body)).toBeNull();
  });
});
