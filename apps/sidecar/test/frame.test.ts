import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  FrameDecoder, FrameError, FrameWriter, encodeFrame,
  MAX_BODY_BYTES, PREAMBLE_BYTES,
} from "../src/frame.js";

/**
 * THE CODEC, ADVERSARIALLY.
 *
 * The sidecar has no TCP listener, so this framing IS the transport. Every
 * property below is one that a pipe will eventually violate on its own if the code does not hold
 * it: chunks split anywhere, several frames in one read, a body larger than any buffer, a peer
 * that stops reading, and two writers racing.
 */

const hdr = (id: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ v: 1, t: "req", id, ...extra });

/** Drain a decoder with a whole buffer delivered in `size`-byte chunks. */
function feed(dec: FrameDecoder, bytes: Buffer, size: number): ReturnType<FrameDecoder["push"]> {
  const out: ReturnType<FrameDecoder["push"]> = [];
  for (let at = 0; at < bytes.length; at += size) out.push(...dec.push(bytes.subarray(at, at + size)));
  return out;
}

describe("FrameDecoder", () => {
  it("round-trips a header and a binary body", () => {
    const body = Buffer.from([0x00, 0xff, 0x0a, 0x7b, 0x22]); // NUL, 0xFF, a newline, `{`, `"`
    const frames = new FrameDecoder().push(encodeFrame(hdr(1), body));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.header).toMatchObject({ v: 1, t: "req", id: 1 });
    expect([...frames[0]!.body]).toEqual([...body]);
  });

  it("a body containing the bytes of a valid preamble is still just a body", () => {
    // The reason this codec is length-prefixed rather than delimited: a body is arbitrary bytes,
    // and an escaping scheme is a thing you get wrong exactly once.
    const inner = encodeFrame(hdr(99), Buffer.from("payload"));
    const frames = new FrameDecoder().push(encodeFrame(hdr(1), inner));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.header.id).toBe(1);
    expect(frames[0]!.body.equals(inner)).toBe(true);
  });

  it("survives arrival one byte at a time", () => {
    const wire = Buffer.concat([encodeFrame(hdr(1), Buffer.from("a")), encodeFrame(hdr(2), Buffer.from("bb"))]);
    const got = feed(new FrameDecoder(), wire, 1);
    expect(got.map((f) => f.header.id)).toEqual([1, 2]);
    expect(got[1]!.body.toString()).toBe("bb");
  });

  it("splits at EVERY byte boundary and always yields the same two frames", () => {
    // A single hand-picked split proves nothing about the split that actually happens in
    // production, which is wherever the kernel felt like ending a read.
    const wire = Buffer.concat([encodeFrame(hdr(1), Buffer.from("first")), encodeFrame(hdr(2), Buffer.from("second"))]);
    for (let cut = 1; cut < wire.length; cut++) {
      const dec = new FrameDecoder();
      const got = [...dec.push(wire.subarray(0, cut)), ...dec.push(wire.subarray(cut))];
      expect(got.map((f) => f.header.id), `split at ${cut}`).toEqual([1, 2]);
      expect(got[0]!.body.toString(), `split at ${cut}`).toBe("first");
      expect(got[1]!.body.toString(), `split at ${cut}`).toBe("second");
      expect(dec.idle, `split at ${cut}`).toBe(true);
    }
  });

  it("delivers several frames out of one chunk", () => {
    const wire = Buffer.concat([1, 2, 3, 4].map((i) => encodeFrame(hdr(i))));
    expect(new FrameDecoder().push(wire).map((f) => f.header.id)).toEqual([1, 2, 3, 4]);
  });

  it("carries an 8 MB body arriving in 64 KB pipe reads", () => {
    // Well past any pipe buffer, and the size at which an implementation that concatenates its
    // whole backlog per chunk stops being usable.
    const body = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < body.length; i += 4096) body.writeUInt32BE(i, i);
    const got = feed(new FrameDecoder(), encodeFrame(hdr(7), body), 64 * 1024);
    expect(got).toHaveLength(1);
    expect(got[0]!.body.length).toBe(body.length);
    expect(got[0]!.body.equals(body)).toBe(true);
  });

  it("reports `idle` false while a frame is half-read", () => {
    const wire = encodeFrame(hdr(1), Buffer.from("xyz"));
    const dec = new FrameDecoder();
    dec.push(wire.subarray(0, wire.length - 1));
    expect(dec.idle).toBe(false);
    dec.push(wire.subarray(wire.length - 1));
    expect(dec.idle).toBe(true);
  });

  describe("refuses rather than allocates", () => {
    it("a body length over the cap", () => {
      const pre = Buffer.alloc(PREAMBLE_BYTES);
      pre.writeUInt32BE(10, 0);
      pre.writeUInt32BE(MAX_BODY_BYTES + 1, 4);
      expect(() => new FrameDecoder().push(pre)).toThrow(FrameError);
      // …and it refuses on the PREAMBLE, before a single body byte has arrived.
      expect(() => new FrameDecoder().push(pre)).toThrow(/exceeds the .* cap/);
    });

    it("a header length over the cap", () => {
      const pre = Buffer.alloc(PREAMBLE_BYTES);
      pre.writeUInt32BE(1024 * 1024, 0);
      pre.writeUInt32BE(0, 4);
      expect(() => new FrameDecoder().push(pre)).toThrow(/header length/);
    });

    it("a zero-length header (a stream that has lost alignment)", () => {
      const pre = Buffer.alloc(PREAMBLE_BYTES);
      expect(() => new FrameDecoder().push(pre)).toThrow(/header length 0/);
    });

    it("a header that is not JSON", () => {
      const junk = Buffer.from("not json at all");
      const pre = Buffer.alloc(PREAMBLE_BYTES);
      pre.writeUInt32BE(junk.length, 0);
      pre.writeUInt32BE(0, 4);
      expect(() => new FrameDecoder().push(Buffer.concat([pre, junk]))).toThrow(/not JSON/);
    });

    it("a header that is JSON but not an object", () => {
      const arr = Buffer.from("[1,2,3]");
      const pre = Buffer.alloc(PREAMBLE_BYTES);
      pre.writeUInt32BE(arr.length, 0);
      pre.writeUInt32BE(0, 4);
      expect(() => new FrameDecoder().push(Buffer.concat([pre, arr]))).toThrow(/must be a JSON object/);
    });

    it("a smaller configured cap, so the limit is the configuration and not a constant", () => {
      const dec = new FrameDecoder({ maxBodyBytes: 16 });
      expect(() => dec.push(encodeFrame(hdr(1), Buffer.alloc(17)))).toThrow(/17 exceeds the 16-byte cap/);
    });
  });
});

describe("FrameWriter", () => {
  it("concurrent writes never interleave their bytes", async () => {
    // `Writable.write` is atomic per CALL, not per frame. Without the writer's serialization, a
    // preamble from one frame lands between the preamble and body of another and the peer can
    // never resynchronise — there is no delimiter to hunt for.
    const pipe = new PassThrough({ highWaterMark: 64 });
    const seen: Buffer[] = [];
    pipe.on("data", (c: Buffer) => seen.push(c));
    const w = new FrameWriter(pipe);

    await Promise.all([
      w.write(hdr(1), Buffer.alloc(4096, 0x11)),
      w.write(hdr(2), Buffer.alloc(4096, 0x22)),
      w.write(hdr(3), Buffer.alloc(4096, 0x33)),
    ]);
    await new Promise((r) => setImmediate(r));

    const got = new FrameDecoder().push(Buffer.concat(seen));
    expect(got.map((f) => f.header.id)).toEqual([1, 2, 3]);
    expect(new Set(got[0]!.body)).toEqual(new Set([0x11]));
    expect(new Set(got[1]!.body)).toEqual(new Set([0x22]));
    expect(new Set(got[2]!.body)).toEqual(new Set([0x33]));
  });

  it("waits for drain instead of buffering unboundedly", async () => {
    // A destination nobody reads. The write must NOT resolve — that is the backpressure this
    // whole design turns on, and a writer that ignored it would be a memory leak wearing a
    // transport's clothes.
    const pipe = new PassThrough({ highWaterMark: 16 });
    const w = new FrameWriter(pipe);
    let resolved = false;
    void w.write(hdr(1), Buffer.alloc(256 * 1024)).then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved, "the writer resolved while the peer was not reading").toBe(false);

    pipe.resume(); // the peer starts reading
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(true);
  });

  it("rejects instead of hanging when the transport is already gone", async () => {
    const pipe = new PassThrough();
    pipe.destroy();
    await expect(new FrameWriter(pipe).write(hdr(1), Buffer.alloc(1024))).rejects.toThrow();
  });

  it("refuses to write past its own caps", async () => {
    const pipe = new PassThrough();
    pipe.resume();
    await expect(new FrameWriter(pipe, { maxBodyBytes: 8 }).write(hdr(1), Buffer.alloc(9))).rejects.toThrow(/refusing/);
  });

  it("a failed frame does not strand the frames queued behind it", async () => {
    const pipe = new PassThrough();
    pipe.resume();
    const w = new FrameWriter(pipe, { maxBodyBytes: 8 });
    const seen: Buffer[] = [];
    pipe.on("data", (c: Buffer) => seen.push(c));
    await expect(w.write(hdr(1), Buffer.alloc(9))).rejects.toThrow();
    await w.write(hdr(2), Buffer.from("ok"));
    expect(new FrameDecoder().push(Buffer.concat(seen)).map((f) => f.header.id)).toEqual([2]);
  });
});
