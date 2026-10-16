import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  AttachmentStagingStorageError, StagedObjectTooLargeError,
  type AttachmentStagingStorage,
} from "@trafficflow/db/cloud";
import { resolveStagedAttachments } from "../src/index.js";

/**
 * ═══ THE SEND-FACING HALF: THE BYTES, RE-MEASURED ══════════════════════════════════════════
 *
 * Everything here runs against an injected storage port — there is no network in this file and
 * there cannot be one. The rule the product depends on:
 *
 *  · **A body larger than its ticket declared is refused.** Mutation: drop the length comparison →
 *    the size-mismatch test goes red, and the cap becomes enforceable only against a number the
 *    client chose.
 *
 * THE WIRE, THE OBJECT PATH AND THE SWEEP MOVED to db's own staging-store test
 * with the code they test: their caller is the worker's maintenance slot, and the worker may not
 * depend on this package (`apps/worker/test/deps.test.ts`). What is left here is the half that
 * turns a ticket into a `SendAttachment` and maps every way that can fail onto a status — which is
 * this package's job and nothing the worker ever calls.
 */

/** A storage port over an in-memory bucket that RECORDS the order of operations. */
function fakeStorage(objects: Record<string, Uint8Array> = {}) {
  const ops: string[] = [];
  const storage: AttachmentStagingStorage = {
    async signUpload(objectPath) {
      ops.push(`sign:${objectPath}`);
      return { uploadUrl: `https://storage.example/${objectPath}?token=t`, uploadMethod: "PUT", uploadHeaders: {} };
    },
    async download(objectPath) {
      ops.push(`download:${objectPath}`);
      const bytes = objects[objectPath];
      if (!bytes) throw new AttachmentStagingStorageError("download", 404, "not found");
      return bytes;
    },
    async remove(paths) {
      ops.push(`remove:${[...paths].join(",")}`);
      for (const p of paths) delete objects[p];
    },
  };
  return { storage, ops, objects };
}

const later = (ms: number): Date => new Date(Date.now() + ms);

describe("resolveStagedAttachments — the bytes, RE-MEASURED", () => {
  const ticket = (over: Partial<{
    id: string; objectPath: string; filename: string; contentType: string;
    sizeBytes: number; contentSha256: string | null; expiresAt: Date;
  }> = {}) => ({
    id: "t1", objectPath: "acc/t1", filename: "a.bin", contentType: "application/octet-stream",
    sizeBytes: 4, contentSha256: null, expiresAt: later(60_000), ...over,
  });
  /** What a client declares for these bytes — the digest the send holds it to. */
  const digestOf = (bytes: Uint8Array): string =>
    createHash("sha256").update(bytes).digest("hex");

  it("resolves in the order the ids name, with the ticket's filename", async () => {
    const { storage } = fakeStorage({ "acc/t1": new Uint8Array([1, 2]), "acc/t2": new Uint8Array([3]) });
    const res = await resolveStagedAttachments(
      storage,
      [ticket(), ticket({ id: "t2", objectPath: "acc/t2", filename: "b.bin" })],
      ["t2", "t1"],
      new Date(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attachments.map((a) => a.filename)).toEqual(["b.bin", "a.bin"]);
  });

  it("REFUSES a body larger than its ticket declared — the cap must not rest on a client's number", async () => {
    const { storage } = fakeStorage({ "acc/t1": new Uint8Array(64) });
    const res = await resolveStagedAttachments(storage, [ticket({ sizeBytes: 4 })], ["t1"], new Date());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toMatchObject({ reason: "size_mismatch", declared: 4, actual: 64 });
  });

  /**
   * CONTENT IDENTITY (cloud 0041). The size was the only thing re-measured, and a different
   * file of the same length passes that: the presigned PUT signs the content TYPE and nothing
   * about the content, so anything holding a grant could put other bytes at the path between the
   * mint and the send. A declared digest is the promise the send holds.
   */
  it("REFUSES bytes that are not the file the ticket declared", async () => {
    const declared = new Uint8Array([1, 2, 3, 4]);
    const swapped = new Uint8Array([9, 9, 9, 9]);   // same length, different file
    const { storage } = fakeStorage({ "acc/t1": swapped });
    const res = await resolveStagedAttachments(
      storage, [ticket({ contentSha256: digestOf(declared) })], ["t1"], new Date(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toMatchObject({ reason: "digest_mismatch", id: "t1" });
  });

  /** THE POSITIVE CONTROL: the ordinary send, whose bytes are the ones it declared. */
  it("admits bytes that match the declared digest", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { storage } = fakeStorage({ "acc/t1": bytes });
    const res = await resolveStagedAttachments(
      storage, [ticket({ contentSha256: digestOf(bytes) })], ["t1"], new Date(),
    );
    expect(res.ok).toBe(true);
  });

  /** AND A TICKET THAT DECLARED NOTHING IS JUDGED AS IT ALWAYS WAS — on size alone. */
  it("a ticket with no declared digest is unaffected", async () => {
    const { storage } = fakeStorage({ "acc/t1": new Uint8Array([9, 9]) });
    const res = await resolveStagedAttachments(
      storage, [ticket({ contentSha256: null, sizeBytes: 4 })], ["t1"], new Date(),
    );
    expect(res.ok).toBe(true);
  });

  it("a SMALLER body is fine — the declaration is a ceiling, not an equality", async () => {
    const { storage } = fakeStorage({ "acc/t1": new Uint8Array(2) });
    const res = await resolveStagedAttachments(storage, [ticket({ sizeBytes: 4 })], ["t1"], new Date());
    expect(res.ok).toBe(true);
  });

  it("an EXPIRED ticket is refused before its object is even asked for", async () => {
    const { storage, ops } = fakeStorage({ "acc/t1": new Uint8Array(2) });
    const res = await resolveStagedAttachments(
      storage, [ticket({ expiresAt: new Date(Date.now() - 1) })], ["t1"], new Date(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.reason).toBe("expired");
    expect(ops).toEqual([]);
  });

  it("an id with no ticket is `unknown` — the same answer a foreign account's id produces", async () => {
    const { storage } = fakeStorage();
    const res = await resolveStagedAttachments(storage, [], ["nope"], new Date());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toEqual({ reason: "unknown", id: "nope" });
  });

  it("a missing OBJECT behind a live ticket is `unavailable`, not `unknown`", async () => {
    // The distinction is worth keeping: one is "that was never yours", the other is "we lost your
    // bytes", and only the second is worth retrying.
    const { storage } = fakeStorage();
    const res = await resolveStagedAttachments(storage, [ticket()], ["t1"], new Date());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.reason).toBe("unavailable");
  });
});

/**
 * ═══ ONE TICKET, ONE DOWNLOAD — THE AMPLIFICATION, AT THE LOOP THAT HAD IT ═════════════════
 *
 * `await storage.download()` sat inside a loop over the CLIENT'S ARRAY, so a request naming one
 * valid one-byte ticket N times pulled the same object N times. The declared total is summed from
 * the ticket, and the ticket declares one byte, so thousands of repeats stayed far under every
 * byte cap in the path — the amplification factor was simply the array length, bought with a
 * single authenticated request. The same line put N copies of the file on the message that went
 * out, which is a correctness bug riding the same defect.
 *
 * The route deduplicates as well. These guards are here rather than only there because the fix
 * that matters is the one at the loop: this is an exported entry point, and a cap upstream still
 * lets the maximum be fetched repeatedly if the loop is willing to.
 *
 * Mutation watched: restore `for (const id of requestedIds)` → the first test reports five
 * downloads for one object and five attachments, and the interleaved one reports four.
 */
describe("resolveStagedAttachments — a repeated id is ONE download and ONE attachment", () => {
  const ticket = (over: Partial<{ id: string; objectPath: string; filename: string }> = {}) => ({
    id: "t1", objectPath: "acc/t1", filename: "a.bin", contentType: "application/octet-stream",
    sizeBytes: 4, contentSha256: null, expiresAt: later(60_000), ...over,
  });

  it("the SAME ticket named five times downloads once and resolves once", async () => {
    const { storage, ops } = fakeStorage({ "acc/t1": new Uint8Array([1, 2]) });
    const res = await resolveStagedAttachments(
      storage, [ticket()], ["t1", "t1", "t1", "t1", "t1"], new Date(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // THE AMPLIFICATION ASSERTION. Counted from the port's own recorded operations, not inferred
    // from the result, because "one attachment came back" and "one request went to storage" are
    // two different claims and only the second is about cost.
    expect(ops.filter((o) => o === "download:acc/t1")).toHaveLength(1);
    expect(res.attachments.map((a) => a.filename)).toEqual(["a.bin"]);
  });

  it("interleaved repeats collapse to first appearance, keeping the composer's order", async () => {
    const { storage, ops } = fakeStorage({
      "acc/t1": new Uint8Array([1]), "acc/t2": new Uint8Array([2]),
    });
    const res = await resolveStagedAttachments(
      storage,
      [ticket(), ticket({ id: "t2", objectPath: "acc/t2", filename: "b.bin" })],
      ["t2", "t1", "t2", "t1"],
      new Date(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attachments.map((a) => a.filename)).toEqual(["b.bin", "a.bin"]);
    expect(ops).toEqual(["download:acc/t2", "download:acc/t1"]);
  });

  it("a repeated UNKNOWN id still fails, and asks storage for nothing", async () => {
    // The dedupe must not turn a bad reference into a tolerated one — it collapses how many times
    // an id is considered, never whether it is checked.
    const { storage, ops } = fakeStorage();
    const res = await resolveStagedAttachments(storage, [], ["nope", "nope"], new Date());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toEqual({ reason: "unknown", id: "nope" });
    expect(ops).toEqual([]);
  });
});

/**
 * the ticket's declared size is a CEILING ON THE READ.
 *
 * The presigned PUT signs only the content TYPE, so an authenticated caller can mint a one-byte
 * ticket, upload an object of any size to the path it names, and then send that ticket. The
 * `byteLength > sizeBytes` comparison that follows the download is correct and too late: the
 * bytes it measures are already in the process. This is the same defect as `download-all`'s
 * per-part fetch and as the request door's — a ceiling applied to the RESULT of an unbounded read.
 *
 * Watched fail and restored: drop the `{ maxBytes: t.sizeBytes }` argument in
 * `resolveStagedAttachments` and the first case reads the whole oversized object before refusing.
 */
describe("a staged object is read under the ticket's ceiling, not measured after it", () => {
  /** A storage that reports what ceiling it was handed and refuses above it, as the real one does. */
  function ceilingAwareStorage(objects: Record<string, Uint8Array>) {
    const seen: Array<number | undefined> = [];
    let bytesRead = 0;
    const storage: AttachmentStagingStorage = {
      async signUpload() {
        return { uploadUrl: "https://s/x", uploadMethod: "PUT", uploadHeaders: {} };
      },
      async download(objectPath, opts) {
        seen.push(opts?.maxBytes);
        const bytes = objects[objectPath];
        if (!bytes) throw new AttachmentStagingStorageError("download", 404, "not found");
        if (opts?.maxBytes !== undefined && bytes.byteLength > opts.maxBytes) {
          // The real ports refuse the declared Content-Length before reading; the fake reports
          // the same outcome and, crucially, retains nothing.
          throw new StagedObjectTooLargeError(opts.maxBytes, bytes.byteLength);
        }
        bytesRead += bytes.byteLength;
        return bytes;
      },
      async remove() { /* nothing */ },
    };
    return { storage, seen, read: () => bytesRead };
  }

  const oneTicket = (sizeBytes: number) => [{
    id: "t1", objectPath: "acc/t1", filename: "f.bin",
    contentType: "application/octet-stream", sizeBytes, contentSha256: null,
    expiresAt: later(60_000),
  }];

  it("hands the ticket's size down as the ceiling and retains nothing over it", async () => {
    // A one-byte ticket against a 10 MiB object — the exact shape a signed-content-type-only PUT
    // makes reachable.
    const { storage, seen, read } = ceilingAwareStorage({ "acc/t1": new Uint8Array(10 * 1024 * 1024) });

    const res = await resolveStagedAttachments(storage, oneTicket(1), ["t1"], new Date());

    expect(seen).toEqual([1]);
    expect(read(), "no bytes were retained for an object over the ceiling").toBe(0);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.failure.reason).toBe("size_mismatch");
    expect(res.ok === false && res.failure.reason === "size_mismatch" && res.failure.declared).toBe(1);
  });

  it("an object AT the declared size is read normally", async () => {
    const { storage, seen, read } = ceilingAwareStorage({ "acc/t1": new Uint8Array(64) });

    const res = await resolveStagedAttachments(storage, oneTicket(64), ["t1"], new Date());

    expect(seen).toEqual([64]);
    expect(read()).toBe(64);
    expect(res.ok).toBe(true);
    expect(res.ok === true && res.attachments[0]!.content.byteLength).toBe(64);
  });

  it("a storage that IGNORES the ceiling is still refused — the comparison after is kept", async () => {
    // `AttachmentStagingStorage` is injectable, so the port cannot be the only enforcement: an
    // older implementation or a fake that ignores `maxBytes` must not be trusted.
    const ignoring: AttachmentStagingStorage = {
      async signUpload() { return { uploadUrl: "https://s/x", uploadMethod: "PUT", uploadHeaders: {} }; },
      async download() { return new Uint8Array(4096); },
      async remove() { /* nothing */ },
    };

    const res = await resolveStagedAttachments(ignoring, oneTicket(16), ["t1"], new Date());

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.failure.reason).toBe("size_mismatch");
  });
});
