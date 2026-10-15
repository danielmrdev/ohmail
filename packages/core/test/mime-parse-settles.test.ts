import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_HTML_TO_TEXT_CHARS, MimeParseError, normalizeMime } from "../src/mime.js";

/**
 * normalizeMime ALWAYS SETTLES. A throw inside mailparser's header processing used to escape as
 * an uncaught exception whenever the head spanned more than one chunk, and the parse stayed
 * pending for ever: the worker and the desktop engine exit on that exception, and the drain behind
 * the message stops. The throw is injected through the parser's prototype (a seam in this
 * process, no dependency file touched), only for a message carrying `X-Fault`; the clock is fake
 * for `setTimeout` alone, because mailparser's own work runs on real `setImmediate` ticks.
 */
const require_ = createRequire(import.meta.url);
const { MailParser } = require_("mailparser") as { MailParser: { prototype: Record<string, unknown> } };
const proto = MailParser.prototype as Record<string, (...a: unknown[]) => unknown>;
const DEADLINE_MS = 30_000;

const msg = (opts: { pad?: number; fault?: boolean; html?: string } = {}): Buffer => Buffer.from([
  "From: Alice <alice@example.com>", "To: bob@example.org", "Subject: settles",
  "Message-ID: <settles@example.com>", ...(opts.fault ? ["X-Fault: 1"] : []),
  ...(opts.pad ? [`X-Pad: ${"p".repeat(opts.pad)}`] : []),
  `Content-Type: ${opts.html !== undefined ? "text/html" : "text/plain"}; charset=utf-8`, "",
  opts.html ?? "hi", "",
].join("\r\n"));

const originals = { processHeaders: proto.processHeaders!, processChunk: proto.processChunk! };
afterEach(() => {
  proto.processHeaders = originals.processHeaders;
  proto.processChunk = originals.processChunk;
  vi.useRealTimers();
});

function injectHeaderThrow(): void {
  proto.processHeaders = function (this: unknown, ...args: unknown[]) {
    const lines = args[0] as Array<{ key: string }>;
    if (lines.some((l) => l.key === "x-fault")) throw new TypeError("injected: the header callback threw");
    return originals.processHeaders.apply(this, args);
  };
}

function track<T>(p: Promise<T>): { state: () => string; error: () => unknown } {
  let state = "pending";
  let error: unknown;
  p.then(() => { state = "resolved"; }, (e: unknown) => { state = "rejected"; error = e; });
  return { state: () => state, error: () => error };
}

const realTicks = async (n = 200): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

describe("normalizeMime settles on a throw inside mailparser's header processing", () => {
  for (const [label, pad] of [["a 64 KiB head", 64 * 1024], ["a 256 KiB head", 256 * 1024], ["a one-chunk head", 0]] as const) {
    it(`${label}: rejects MimeParseError (refused), and nothing escapes`, async () => {
      const escaped: unknown[] = [];
      const onUncaught = (e: unknown): void => { escaped.push(e); };
      process.on("uncaughtException", onUncaught);
      try {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        injectHeaderThrow();
        const t = track(normalizeMime(msg({ fault: true, pad })));
        await realTicks();
        await vi.advanceTimersByTimeAsync(DEADLINE_MS * 2);
        await realTicks(20);
        expect(t.state(), "the parse never settled — the throw escaped the parse").toBe("rejected");
        const err = t.error();
        expect(err).toBeInstanceOf(MimeParseError);
        expect((err as MimeParseError).reason).toBe("refused");
        expect(((err as Error).cause as Error).message).toBe("injected: the header callback threw");
        expect(escaped, "the throw reached uncaughtException").toEqual([]);
      } finally {
        process.off("uncaughtException", onUncaught);
      }
    });
  }

  it("the control: the same message without the fault parses", async () => {
    injectHeaderThrow();
    const m = await normalizeMime(msg({ pad: 64 * 1024 }));
    expect(m.from.address).toBe("alice@example.com");
    expect(m.to.map((a) => a.address)).toEqual(["bob@example.org"]);
  });
});

describe("an attachment stream's error settles the parse", () => {
  it("a fault in an attachment's stream rejects MimeParseError, and nothing escapes", async () => {
    const escaped: unknown[] = [];
    const onUncaught = (e: unknown): void => { escaped.push(e); };
    process.on("uncaughtException", onUncaught);
    try {
      // The attachment's hashing stream fails its first chunk, the way a Transform reports a fault.
      type Hasher = { _transform(c: unknown, e: unknown, done: (err?: Error) => void): void };
      proto.processChunk = function (this: { attachmentList: Array<{ content: Hasher }> }, ...args: unknown[]) {
        const before = this.attachmentList.length;
        const out = originals.processChunk.apply(this, args);
        const added = this.attachmentList[before];
        if (added) added.content._transform = (_c, _e, done) => done(new Error("injected: the attachment stream failed"));
        return out;
      };
      const raw = Buffer.from([
        "From: Alice <alice@example.com>", "To: bob@example.org", "Subject: file",
        'Content-Type: multipart/mixed; boundary="B"', "", "--B", "Content-Type: text/plain", "", "hi",
        "--B", "Content-Type: application/pdf", "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="a.pdf"', "", "JVBERi0xLjQK".repeat(2000), "--B--", "",
      ].join("\r\n"));
      const t = track(normalizeMime(raw));
      await realTicks(400);
      expect(t.state()).toBe("rejected");
      expect(t.error()).toBeInstanceOf(MimeParseError);
      expect(escaped, "the stream's error reached uncaughtException").toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});

describe("a parse that stops is a parse_timeout at the deadline, not before", () => {
  it("rejects MimeParseError (parse_timeout) at 30 s and is pending at 30 s less 1 ms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    proto.processChunk = function () { /* never calls back: the parse stops */ };
    const t = track(normalizeMime(msg()));
    await realTicks();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(t.state()).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(t.state()).toBe("rejected");
    expect(t.error()).toBeInstanceOf(MimeParseError);
    expect((t.error() as MimeParseError).reason).toBe("parse_timeout");
  });

  it("one budget covers the fallback re-parse: it expires 30 s after the FIRST parse began", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let firstDelayed = false;
    let fallbackStarted = false;
    proto.processChunk = function (this: { options: { skipHtmlToText?: boolean } }, ...args: unknown[]) {
      if (this.options.skipHtmlToText) { fallbackStarted = true; return; }   // the fallback stops
      if (!firstDelayed) {
        firstDelayed = true;
        setTimeout(() => { originals.processChunk.apply(this, args); }, 20_000);
        return;
      }
      return originals.processChunk.apply(this, args);
    };
    const t = track(normalizeMime(msg({ html: `<p>${"x".repeat(MAX_HTML_TO_TEXT_CHARS + 16)}</p>` })));
    await realTicks();
    await vi.advanceTimersByTimeAsync(20_000);
    await realTicks();
    expect(fallbackStarted, "the html-to-text refusal never sent the message to the fallback").toBe(true);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 20_000 - 1);
    expect(t.state()).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(t.state(), "the fallback ran on a clock of its own").toBe("rejected");
    expect((t.error() as MimeParseError).reason).toBe("parse_timeout");
  });

  it("the deadline is 30 s", async () => {
    const { MIME_PARSE_DEADLINE_MS } = await import("../src/mime-parse.js");
    expect(MIME_PARSE_DEADLINE_MS).toBe(DEADLINE_MS);
  });
});

describe("a throw in a text part's stream callback settles the parse", () => {
  // A text part's content stream, and the charset and flowed decoders piped into it, call back on
  // later ticks with no caller: at the base a throw there escaped and exited the process.
  type TextNode = { contentStream?: { read: (n?: number) => unknown }; isAttachment?: boolean };
  const textMsg = (ct: string, body: string, fault: boolean): Buffer => Buffer.from([
    "From: Alice <alice@example.com>", "To: bob@example.org", "Subject: text",
    ...(fault ? ["X-Fault: 1"] : []), `Content-Type: ${ct}`, "", body, "",
  ].join("\r\n"));
  const SHAPES = [
    ["a utf-8 part", "text/plain; charset=utf-8", "hi", "hi\n"],
    ["a 64 KiB utf-8 part", "text/plain; charset=utf-8", "x".repeat(64 * 1024), `${"x".repeat(64 * 1024)}\n`],
    ["a charset-decoded part", "text/plain; charset=iso-8859-1", "caf=E9", "caf=E9\n"],
    ["a flowed, charset-decoded part", "text/plain; charset=iso-8859-1; format=flowed", "a \r\nb", "a b"],
  ] as const;

  function injectTextStreamThrow(): void {
    proto.processChunk = function (this: { curnode?: TextNode; headers?: unknown }, ...args: unknown[]) {
      const out = originals.processChunk.apply(this, args);
      const node = this.curnode;
      if ((args[0] as { type: string }).type === "node" && node?.contentStream && !node.isAttachment
        && (this.headers instanceof Map && this.headers.has("x-fault"))) {
        // Only the listener's own call (no size): the stream's internals read(0), and must not throw.
        const read = node.contentStream.read.bind(node.contentStream);
        node.contentStream.read = (n?: number) => {
          if (n === undefined) throw new TypeError("injected: the text stream callback threw");
          return read(n);
        };
      }
      return out;
    };
  }

  for (const [label, ct, body] of SHAPES) {
    it(`${label}, a throw in its stream's readable listener: rejects MimeParseError (refused), and nothing escapes`, async () => {
      const escaped: unknown[] = [];
      const onUncaught = (e: unknown): void => { escaped.push(e); };
      process.on("uncaughtException", onUncaught);
      try {
        injectTextStreamThrow();
        const t = track(normalizeMime(textMsg(ct, body, true)));
        await realTicks(400);
        expect(t.state(), "the parse never settled — the throw escaped the parse").toBe("rejected");
        expect(t.error()).toBeInstanceOf(MimeParseError);
        expect((t.error() as MimeParseError).reason).toBe("refused");
        expect(((t.error() as Error).cause as Error).message).toBe("injected: the text stream callback threw");
        expect(escaped, "the throw reached uncaughtException").toEqual([]);
      } finally {
        process.off("uncaughtException", onUncaught);
      }
    });
  }

  it("the control: the same parts without the fault parse to their text", async () => {
    injectTextStreamThrow();
    for (const [, ct, body, text] of SHAPES) {
      expect((await normalizeMime(textMsg(ct, body, false))).textBody).toBe(text);
    }
  });
});

describe("every other callback the parser runs settles the parse", () => {
  // Each reached only from a later tick: the parse's reader (it calls `read()` when the text part's
  // decoder ends), and an attachment's `end` (its listener releases the attachment).
  const readableRead = proto.read!;
  afterEach(() => { delete (proto as Record<string, unknown>).read; });
  const BOOM = "injected: a parser callback threw";
  const faulty = (): Buffer => Buffer.from(["From: Alice <alice@example.com>", "To: bob@example.org",
    "Subject: cb", "X-Fault: 1", "Content-Type: text/plain; charset=utf-8", "", "hi", ""].join("\r\n"));
  const attachmentMsg = Buffer.from([
    "From: Alice <alice@example.com>", "X-Fault: 1", "Subject: file", 'Content-Type: multipart/mixed; boundary="B"', "",
    "--B", "Content-Type: text/plain", "", "hi", "--B", "Content-Type: application/pdf",
    "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="a.pdf"', "", "JVBERi0xLjQK", "--B--", "",
  ].join("\r\n"));
  type Self = { headers?: unknown; attachmentList: Array<{ release: () => void }> };
  const SEAMS: Array<[string, () => void, Buffer]> = [
    ["the parse's own reader", () => {
      proto.read = function (this: Self, ...a: unknown[]) {
        if (a[0] === undefined && (this.headers instanceof Map && this.headers.has("x-fault"))) throw new TypeError(BOOM);
        return readableRead.apply(this, a);
      };
    }, faulty()],
    ["an attachment's end", () => {
      proto.processChunk = function (this: Self, ...args: unknown[]) {
        const before = this.attachmentList.length;
        const out = originals.processChunk.apply(this, args);
        const added = this.attachmentList[before];
        if (added) added.release = () => { throw new TypeError(BOOM); };
        return out;
      };
    }, attachmentMsg],
  ];

  for (const [label, inject, raw] of SEAMS) {
    it(`${label}: a throw there rejects MimeParseError (refused), and nothing escapes`, async () => {
      const escaped: unknown[] = [];
      const onUncaught = (e: unknown): void => { escaped.push(e); };
      process.on("uncaughtException", onUncaught);
      try {
        inject();
        const t = track(normalizeMime(raw));
        await realTicks(400);
        expect(t.state(), "the parse never settled — the throw escaped the parse").toBe("rejected");
        expect((t.error() as MimeParseError).reason).toBe("refused");
        expect(((t.error() as Error).cause as Error).message).toBe(BOOM);
        expect(escaped, "the throw reached uncaughtException").toEqual([]);
      } finally {
        process.off("uncaughtException", onUncaught);
      }
    });
  }
});
