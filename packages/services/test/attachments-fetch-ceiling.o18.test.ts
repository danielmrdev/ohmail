import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { attachments as attachmentsTbl } from "@trafficflow/db";
import {
  AttachmentsService, ATTACHMENT_MAX_FETCH_BYTES, type OpenAdapter, type AttachmentAdapter,
} from "../src/attachments-service.js";
import { ServiceError } from "../src/errors.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * Gap the single-attachment fetch ceiling.
 *
 * The point of these is NOT that a limit exists but that it fires in the two places it has to and
 * arrives as the right STATUS. A ceiling that only pre-flights on stored metadata enforces nothing
 * (the size is the sender's claim); a ceiling that throws core's error without translating it
 * reaches the user as `502 upstream_unavailable`, blaming their mail server for our refusal.
 */

const svc = new AttachmentsService();

async function seedAtt(
  db: Awaited<ReturnType<typeof makeCtx>>["db"], accountId: string, messageId: string, sizeBytes: number,
): Promise<string> {
  const [row] = await db.insert(attachmentsTbl).values({
    accountId, messageId,
    filename: `big-${randomUUID()}.bin`,
    contentType: "application/octet-stream",
    sizeBytes, inline: false, partId: "2",
  }).returning();
  return row!.id;
}

/** Records whether it was opened at all, and what ceiling it was handed. */
function spyAdapter(onFetch?: (opts?: { maxBytes?: number }) => Promise<{ body: Uint8Array }>) {
  const state = { opened: 0, closed: 0, sawMaxBytes: undefined as number | undefined };
  const openAdapter: OpenAdapter = async (): Promise<AttachmentAdapter> => {
    state.opened += 1;
    return {
      fetchPart: async (_l, _p, opts) => {
        state.sawMaxBytes = opts?.maxBytes;
        const r = await (onFetch?.(opts) ?? Promise.resolve({ body: new Uint8Array([1, 2, 3]) }));
        return { contentType: "application/octet-stream", filename: null, body: r.body };
      },
      close: async () => { state.closed += 1; },
    };
  };
  return { openAdapter, state };
}

describe("fetchBytes size ceiling", () => {
  it("refuses an oversized attachment from METADATA ALONE, without opening a connection", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const id = await seedAtt(db, accountId, messageId, ATTACHMENT_MAX_FETCH_BYTES + 1);
    const { openAdapter, state } = spyAdapter();

    const err = await svc.fetchBytes(ctx, id, { openAdapter }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(413);
    expect((err as ServiceError).code).toBe("payload_too_large");
    // The whole value of the pre-flight: the user's mail server was never contacted.
    expect(state.opened).toBe(0);
  });

  it("passes the ceiling DOWN to fetchPart — the metadata is only the sender's claim", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    // Metadata says 10 bytes. Under the pre-flight, so the only thing that can stop a lying
    // sender is the ceiling reaching the stream.
    const id = await seedAtt(db, accountId, messageId, 10);
    const { openAdapter, state } = spyAdapter();

    await svc.fetchBytes(ctx, id, { openAdapter });

    expect(state.sawMaxBytes).toBe(ATTACHMENT_MAX_FETCH_BYTES);
  });

  it("translates a mid-stream breach into 413, not the route's blanket 502", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const id = await seedAtt(db, accountId, messageId, 10);   // lying metadata
    const tooLarge = Object.assign(new Error("part exceeds ceiling"), { code: "EATTACHTOOLARGE" });
    const { openAdapter, state } = spyAdapter(() => Promise.reject(tooLarge));

    const err = await svc.fetchBytes(ctx, id, { openAdapter }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(413);
    expect((err as ServiceError).code).toBe("payload_too_large");
    // The abort poisons the connection, so it MUST be closed rather than returned to any pool.
    expect(state.closed).toBe(1);
  });

  it("translates a STALE LOCATOR into an honest 404, not the route's blanket 502", async () => {
    // `ImapAdapter` raises `MessageGoneError` (code `EMSGGONE`) when the message is not at the
    // locator — expunged, moved from another client, or, since the UIDVALIDITY guard landed, its
    // folder recreated under a new epoch, in which case the adapter refuses rather than handing
    // back part n of whatever now wears the UID. Untranslated, the route's blanket 502 says "the
    // mail server is having trouble", which is false and leaves the reader nothing to do.
    //
    // Duck-typed by CODE for the reason the ceiling case is: this package must not import the
    // adapter, so a nominal `instanceof` would be untestable here and wrong in production.
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const id = await seedAtt(db, accountId, messageId, 10);
    const gone = Object.assign(new Error("message not at source locator Junk#7:2"), { code: "EMSGGONE" });
    const { openAdapter, state } = spyAdapter(() => Promise.reject(gone));

    const err = await svc.fetchBytes(ctx, id, { openAdapter }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(404);
    expect((err as ServiceError).code).toBe("not_found");
    // And it says what to do about it, because the fix is real: the next sync re-resolves the
    // locator by Message-ID.
    expect((err as ServiceError).message).toMatch(/refresh/i);
    expect(state.closed).toBe(1);
  });

  it("leaves an ordinary fetch failure alone (still 502, not a size refusal)", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const id = await seedAtt(db, accountId, messageId, 10);
    const { openAdapter, state } = spyAdapter(() => Promise.reject(new Error("connection reset")));

    const err = await svc.fetchBytes(ctx, id, { openAdapter }).catch((e: unknown) => e);

    // NOT a ServiceError — the route turns this into 502 upstream_unavailable, which is correct
    // here and wrong for a ceiling breach. If this ever becomes a 413 the translation is too broad.
    expect(err).not.toBeInstanceOf(ServiceError);
    expect((err as Error).message).toContain("connection reset");
    expect(state.closed).toBe(1);
  });

  it("a size exactly AT the ceiling is allowed through", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const id = await seedAtt(db, accountId, messageId, ATTACHMENT_MAX_FETCH_BYTES);
    const { openAdapter, state } = spyAdapter();

    const out = await svc.fetchBytes(ctx, id, { openAdapter });

    expect(out.body.byteLength).toBe(3);
    expect(state.opened).toBe(1);
  });
});
