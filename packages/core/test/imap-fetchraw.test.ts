import { describe, it, expect } from "vitest";
import {
  ImapAdapter, RawMessageTooLargeError, MessageGoneError, DEFAULT_FETCH_RAW_MAX_BYTES,
} from "../src/adapters/imap.js";
import type { NativeLocator } from "../src/types.js";

/**
 * `ImapAdapter.fetchRaw` — re-reading ONE whole message without changing anything about it.
 *
 * Three properties are worth a guard, and they are the three a caller cannot check for itself:
 *
 *  · it asks for the SOURCE, which is the only thing that makes the wire form `BODY.PEEK[]` and
 *    therefore the only thing that stops a re-read from marking somebody's mail as read;
 *  · the ceiling reaches the DRIVER rather than being enforced by abandoning the stream, because
 *    the caller runs on a connection it must hand back intact;
 *  · a short read is REFUSED. This is the one that matters most: the caller re-parses these bytes
 *    and decides whether the message is sensitive, and a message missing its tail is a message
 *    with less to find. Returning it quietly biases that decision toward "clean".
 */

const locator: NativeLocator = { folder: "INBOX", ref: "1:42" };

/** A message delivered as `chunks`, recording what the adapter asked the driver for. */
function fakeAdapter(chunks: Buffer[], expectedSize?: number) {
  const state = {
    pulled: 0,
    released: 0,
    part: "unset" as unknown,
    options: null as Record<string, unknown> | null,
  };
  const content = (async function* () {
    for (const c of chunks) { state.pulled += 1; yield c; }
  })();
  const adapter = new ImapAdapter({
    host: "example.invalid", port: 993, secure: true, auth: { user: "u", pass: "p" },
  });
  const total = chunks.reduce((n, c) => n + c.length, 0);
  (adapter as unknown as { delimiter: string }).delimiter = "/"; // what connect() learns on a flat server
  (adapter as unknown as { client: unknown }).client = {
    getMailboxLock: async () => ({ release: () => { state.released += 1; } }),
    // The SELECTED mailbox, as every real server reports it: `[UIDVALIDITY n]` is required on a
    // successful SELECT, and the epoch guard refuses a locator-addressed command when it is
    // absent. A stand-in without it models a server that does not exist.
    mailbox: { path: "INBOX", uidValidity: 1n },
    download: async (_range: string, part: unknown, options: Record<string, unknown>) => {
      state.part = part;
      state.options = options;
      return { content, meta: { expectedSize: expectedSize ?? total, contentType: "message/rfc822" } };
    },
  };
  return { adapter, state };
}

describe("fetchRaw — a read-only re-read of one whole message", () => {
  it("asks for the SOURCE, which is what makes the wire form BODY.PEEK[]", async () => {
    const { adapter, state } = fakeAdapter([Buffer.from("From: a@b\r\n\r\nhi")]);

    await adapter.fetchRaw(locator);

    // `undefined`, not `""`. Both reach imapflow's source branch — one because it is the absence
    // of a part, the other because an empty string happens to be falsy. Only the first says so.
    expect(state.part).toBeUndefined();
    expect(state.options).toMatchObject({ uid: true });
  });

  it("returns the bytes UNCHANGED — a re-parse has to see what the server holds", async () => {
    const raw = "From: a@b\r\nSubject: x\r\n\r\nline one\r\nline two\r\n";
    const { adapter } = fakeAdapter([Buffer.from(raw, "utf8")]);

    const out = await adapter.fetchRaw(locator);

    expect(Buffer.from(out).toString("utf8")).toBe(raw);
  });

  it("hands the ceiling to the DRIVER instead of abandoning the stream", async () => {
    // The contrast with `fetchPart` is the whole design: that one throws out of its own
    // `for await`, which kills the connection. This one must leave the socket usable, so the
    // limit has to be the driver's — every chunk it stops before is a request never issued.
    const { adapter, state } = fakeAdapter([Buffer.alloc(10)]);

    await adapter.fetchRaw(locator, { maxBytes: 4096 });

    expect(state.options).toMatchObject({ uid: true, maxBytes: 4096 });
  });

  it("defaults the ceiling rather than reading unbounded", async () => {
    const { adapter, state } = fakeAdapter([Buffer.alloc(10)]);

    await adapter.fetchRaw(locator);

    expect(state.options?.maxBytes).toBe(DEFAULT_FETCH_RAW_MAX_BYTES);
  });

  it("REFUSES a message over the ceiling, naming the server's own size", async () => {
    // The driver truncates silently at its limit, so "what came back" cannot detect this. The
    // server's RFC822.SIZE can, and it is a real number rather than a guess precisely because
    // nothing was abandoned.
    const { adapter, state } = fakeAdapter([Buffer.alloc(200)], 9_000_000);

    const err = await adapter.fetchRaw(locator, { maxBytes: 200 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RawMessageTooLargeError);
    expect((err as RawMessageTooLargeError).sizeBytes).toBe(9_000_000);
    expect((err as RawMessageTooLargeError).limitBytes).toBe(200);
    expect(state.released).toBe(1);
  });

  it("REFUSES a short read even when no ceiling explains it", async () => {
    // A transfer that ended early for any other reason. Returning these bytes would hand the
    // caller a message whose tail is missing, with nothing to notice it by.
    const { adapter } = fakeAdapter([Buffer.alloc(100)], 500);

    const err = await adapter.fetchRaw(locator, { maxBytes: 4096 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RawMessageTooLargeError);
  });

  it("accepts a read that MATCHES the declared size", async () => {
    const { adapter, state } = fakeAdapter([Buffer.alloc(100), Buffer.alloc(400)], 500);

    const out = await adapter.fetchRaw(locator, { maxBytes: 4096 });

    expect(out.byteLength).toBe(500);
    expect(state.pulled).toBe(2);
    expect(state.released).toBe(1);
  });

  it("tolerates a server that declares no size — there is nothing to compare against", async () => {
    const { adapter, state } = fakeAdapter([Buffer.alloc(64)]);
    (adapter as unknown as { client: { download: unknown } }).client.download = async () => ({
      content: (async function* () { yield Buffer.alloc(64); })(),
      meta: { contentType: "message/rfc822" },
    });

    const out = await adapter.fetchRaw(locator, { maxBytes: 4096 });

    expect(out.byteLength).toBe(64);
    void state;
  });

  it("raises MessageGoneError when the locator no longer resolves", async () => {
    const { adapter, state } = fakeAdapter([]);
    (adapter as unknown as { client: { download: unknown } }).client.download = async () => ({});

    const err = await adapter.fetchRaw(locator).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MessageGoneError);
    // The lock is released on the failure path too, or one vanished message wedges the mailbox.
    expect(state.released).toBe(1);
  });
});
