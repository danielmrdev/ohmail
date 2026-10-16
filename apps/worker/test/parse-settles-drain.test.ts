import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mailboxes, messageFailures, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { MimeParseError, UNMETERED_STORAGE_CAP, normalizeMime } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import {
  DeadLetterLedger, ESCALATE_AFTER_ATTEMPTS, classifyIngestFault, nextAttemptAfter,
} from "../src/dead-letter.js";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A PARSE THAT CANNOT FINISH COSTS ONE MESSAGE, NEVER THE DRAIN. mailparser's header processing
 * runs on a later tick for any head over one chunk, so a throw there used to escape as an
 * uncaught exception — the worker exits on it, and the restart fetches the same message again.
 * The throw is injected on the parser's prototype for messages carrying `X-Fault` only (a seam in
 * this process; the parser is the one the engine itself resolves). A refusal is deterministic, a
 * parse that stops is transient: retried, then on the clock, escalated, never written off at once.
 */
const coreRequire = createRequire(fileURLToPath(new URL("../../../packages/core/package.json", import.meta.url)));
const { MailParser } = coreRequire("mailparser") as { MailParser: { prototype: Record<string, unknown> } };
const proto = MailParser.prototype as Record<string, (...a: unknown[]) => unknown>;
const originals = { processHeaders: proto.processHeaders!, processChunk: proto.processChunk! };
afterEach(() => {
  proto.processHeaders = originals.processHeaders;
  proto.processChunk = originals.processChunk;
  vi.useRealTimers();
});

function injectHeaderThrow(): void {
  proto.processHeaders = function (this: unknown, ...args: unknown[]) {
    if ((args[0] as Array<{ key: string }>).some((l) => l.key === "x-fault")) {
      throw new TypeError("injected: the header callback threw");
    }
    return originals.processHeaders.apply(this, args);
  };
}

/** A throw inside a text part's content-stream `readable` listener, for messages carrying `X-Fault`. */
function injectTextStreamThrow(): void {
  type Node = { contentStream?: { read: (n?: number) => unknown }; isAttachment?: boolean };
  proto.processChunk = function (this: { curnode?: Node; headers?: unknown }, ...args: unknown[]) {
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

/** The value, or a refusal naming the hang — a never-settling promise must not become the case's timeout. */
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([p, new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms).unref();
})]);

const PAD = `X-Pad: ${"p".repeat(64 * 1024)}`;
const loc = { folder: "INBOX", ref: "9:4" };

describe("the parse door's two refusals take the ladder's two arms", () => {
  it("a throw in the header callback is mime_unparseable, written off on its first failure", async () => {
    injectHeaderThrow();
    const raw = Buffer.from(["From: a@x.test", "X-Fault: 1", PAD, "Subject: s", "", "hi"].join("\r\n"));
    const err = await within(normalizeMime(raw).then(() => null, (e: unknown) => e), 4_000, "the parse");
    expect(err).toBeInstanceOf(MimeParseError);
    const fault = classifyIngestFault(err);
    expect(fault).toEqual({ domain: "message", code: "mime_unparseable", deterministic: true });
    expect(new DeadLetterLedger().record(loc, fault as { code: "mime_unparseable"; deterministic: true })).toBe("skip");
  });

  it("a parse that stops is TRANSIENT: retried first, then on the clock, and escalated", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    proto.processChunk = function () { /* never calls back */ };
    let err: unknown = "pending";
    void normalizeMime(Buffer.from("From: a@x.test\r\nSubject: s\r\n\r\nhi")).catch((e: unknown) => { err = e; });
    for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(err).toBeInstanceOf(MimeParseError);
    expect((err as MimeParseError).reason).toBe("parse_timeout");

    const fault = classifyIngestFault(err);
    expect(fault).toEqual({ domain: "message", code: "unclassified", deterministic: false });
    const f = fault as { code: "unclassified"; deterministic: false };
    const ledger = new DeadLetterLedger();
    ledger.beginCycle();
    expect(ledger.record(loc, f), "a timeout was written off on its first occurrence").toBe("retry");
    ledger.beginCycle();
    expect(ledger.record(loc, f)).toBe("skip");
    expect(nextAttemptAfter(f.code, 2, new Date(0)), "a timeout waits for a new build instead of its clock").not.toBeNull();
    ledger.record(loc, f);
    expect(ledger.entries()[0]!.attempts).toBe(ESCALATE_AFTER_ATTEMPTS);
    expect(ledger.escalated).toBe(1);
  });
});

describe("the drain continues past a message whose parser callback throws", () => {
  for (const [where, inject, extra] of [
    ["header callback", injectHeaderThrow, [PAD]],
    ["text part's stream callback", injectTextStreamThrow, []],
  ] as const) it(`${where}: the cycle settles, the other two messages land, and the one is recorded mime_unparseable`, async () => {
    const ACCOUNT = "00000000-0000-4000-8000-00000000fa26";
    const db = (await makeTestDb()) as unknown as Tx;
    const [mb] = await db.insert(mailboxes).values({
      accountId: ACCOUNT, provider: "imap", address: `settle-${randomUUID().slice(0, 8)}@x.test`,
    }).returning();
    const mailboxId = mb!.id;
    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId: ACCOUNT, mailboxId, onConnectionError: () => { /* nothing dials here */ } },
    );
    const tag = randomUUID();
    fleet.behave(mailboxId, {
      deliver: [
        { from: "s@x.example", subject: "before", messageId: `before-${tag}@x` },
        { from: "s@x.example", subject: "poison", messageId: `poison-${tag}@x`, headers: ["X-Fault: 1", ...extra] },
        { from: "s@x.example", subject: "after", messageId: `after-${tag}@x` },
      ],
    });
    inject();
    const escaped: unknown[] = [];
    const onUncaught = (e: unknown): void => { escaped.push(e); };
    process.on("uncaughtException", onUncaught);
    try {
      await within(runSyncCycle({
        writeAuthority: FIXTURE_LEASE,
        repo: makeDrizzleRepo(db as never), adapter, accountId: ACCOUNT, mailboxId,
        storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
      }), 20_000, "the sync cycle");
      for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    expect(escaped, "a throw escaped the parse: the worker exits on it").toEqual([]);

    const landed = await db.select({ subject: messages.subject }).from(messages).where(eq(messages.mailboxId, mailboxId));
    expect(landed.map((m) => m.subject).sort()).toEqual(["after", "before"]);
    const failed = await db.select({ code: messageFailures.code }).from(messageFailures)
      .where(eq(messageFailures.mailboxId, mailboxId));
    expect(failed.map((r) => r.code)).toEqual(["mime_unparseable"]);
  }, 60_000);
});
