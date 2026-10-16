/**
 * The PHONE's parse always settles too. The phone runs the same door from its own bundle, so the
 * throw is injected on the bundle's own copy of mailparser (exported by the probe beside the
 * parse) for messages carrying `X-Fault`, and the probe is built with the artifact's plugin and
 * aliases. Measured at the base: a 64 KiB head stayed pending with an uncaught exception, which
 * a release build of the app reports as fatal; a parse that stops had no end at all.
 */
import { createRequire } from "node:module";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { REPO, bundleProbe } from "../scripts/bundle-engine.mjs";

const require_ = createRequire(import.meta.url);
type Proto = Record<string, (...a: unknown[]) => unknown>;
type Phone = {
  parse: (b64: string) => Promise<{ from: { address: string } }>;
  MailParser: { prototype: Proto };
};
const PAD = `X-Pad: ${"p".repeat(64 * 1024)}`;
const msg = (extra: string[], body = "hi") => Buffer.from(["From: Alice <alice@example.com>", "To: bob@example.org",
  ...extra, "Subject: settles", "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n")).toString("base64");
const BIG_BODY = "x".repeat(64 * 1024);

let dir = "";
let phone: Phone;
let originals: { processHeaders: (...a: unknown[]) => unknown; processChunk: (...a: unknown[]) => unknown };
beforeAll(async () => {
  const mime = JSON.stringify(join(REPO, "packages", "core", "src", "mime.ts"));
  const parser = JSON.stringify(realpathSync(require_.resolve("mailparser", { paths: [join(REPO, "packages", "core")] })));
  const probe = await bundleProbe(
    `import { normalizeMime } from ${mime};\nimport { MailParser } from ${parser};\nexport { MailParser };\n`
    + "export const parse = (b64: string) => normalizeMime(Buffer.from(b64, \"base64\"));\n",
  );
  dir = probe.dir;
  const Module = require_("node:module") as { _load(req: string, parent: unknown, isMain: boolean): unknown };
  const original = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    return request === "react-native-quick-crypto" ? require_("node:crypto") : original.call(this, request, parent, isMain);
  };
  try {
    phone = require_(probe.bundlePath) as Phone;
  } finally { Module._load = original; }
  const p = phone.MailParser.prototype;
  originals = { processHeaders: p.processHeaders!, processChunk: p.processChunk! };
}, 120_000);
afterEach(() => {
  phone.MailParser.prototype.processHeaders = originals.processHeaders;
  phone.MailParser.prototype.processChunk = originals.processChunk;
  vi.useRealTimers();
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const settledWithin = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([p, new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error(`the phone's parse did not settle within ${ms} ms`)), ms).unref();
})]);

describe("the phone's parse always settles", () => {
  it("the control: a 64 KiB head parses and names its sender", async () => {
    expect((await settledWithin(phone.parse(msg([PAD])), 4_000)).from.address).toBe("alice@example.com");
  });

  it("a throw in the header callback rejects MimeParseError (refused) and nothing escapes", async () => {
    const escaped: unknown[] = [];
    const onUncaught = (e: unknown): void => { escaped.push(e); };
    process.on("uncaughtException", onUncaught);
    try {
      phone.MailParser.prototype.processHeaders = function (this: unknown, ...args: unknown[]) {
        if ((args[0] as Array<{ key: string }>).some((l) => l.key === "x-fault")) throw new TypeError("injected");
        return originals.processHeaders.apply(this, args);
      };
      const err = await settledWithin(phone.parse(msg(["X-Fault: 1", PAD])).then(() => null, (e: unknown) => e), 4_000);
      expect((err as Error).name).toBe("MimeParseError");
      expect((err as { reason?: string }).reason).toBe("refused");
      expect(escaped).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("a throw in a text part's stream callback rejects MimeParseError (refused) and nothing escapes", async () => {
    const escaped: unknown[] = [];
    const onUncaught = (e: unknown): void => { escaped.push(e); };
    process.on("uncaughtException", onUncaught);
    try {
      type Node = { contentStream?: { read: (n?: number) => unknown }; isAttachment?: boolean };
      phone.MailParser.prototype.processChunk = function (this: { curnode?: Node; headers?: unknown }, ...args: unknown[]) {
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
      const err = await settledWithin(phone.parse(msg(["X-Fault: 1"], BIG_BODY)).then(() => null, (e: unknown) => e), 4_000);
      expect((err as Error).name).toBe("MimeParseError");
      expect((err as { reason?: string }).reason).toBe("refused");
      expect(escaped).toEqual([]);
      expect((await settledWithin(phone.parse(msg([], BIG_BODY)), 4_000)).from.address, "the control").toBe("alice@example.com");
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("a parse that stops rejects MimeParseError (parse_timeout) at 30 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    phone.MailParser.prototype.processChunk = function () { /* never calls back */ };
    let err: unknown = "pending";
    void phone.parse(msg([])).catch((e: unknown) => { err = e; });
    for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(err).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect((err as { reason?: string }).reason).toBe("parse_timeout");
  });
});
