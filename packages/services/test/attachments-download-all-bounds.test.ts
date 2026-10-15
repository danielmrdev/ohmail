import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { attachments as attachmentsTbl } from "@trafficflow/db";
import {
  AttachmentsService, DOWNLOAD_ALL_MAX_BYTES, DOWNLOAD_ALL_MAX_PARTS,
  type AttachmentAdapter, type OpenAdapter,
} from "../src/attachments-service.js";
import { ServiceError } from "../src/errors.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * the three `download-all` instances, each driven with the hostile
 * value through the real service.
 *
 * The shape all three share is the one the class is named for: **the ceiling was applied to the
 * RESULT and not to the READ.** `DOWNLOAD_ALL_MAX_PARTS` was checked on an array `resolveTargets`
 * had already built, and `DOWNLOAD_ALL_MAX_BYTES` on a total that is only consulted between
 * parts — so in all three cases the refusal was correct and the work behind it was unbounded.
 *
 * ── THE MUTATIONS, WATCHED FAIL AND RESTORED ────────────────────────────────────────────────
 *
 *  1. Delete the `fileIds.length > DOWNLOAD_ALL_MAX_PARTS` block in `resolveTargets`
 *     → "refuses an over-long fileIds list BEFORE it becomes a SQL `IN`" goes red: the query runs
 *       with 300 bind parameters and the service answers 404 "no attachments to download"
 *       (nothing matches the invented ids) instead of 413.
 *  2. Delete `.limit(DOWNLOAD_ALL_MAX_PARTS + 1)` in `partsWhere`
 *     → "refuses without reading the whole library" goes red on the SQL, not on the status:
 *       `expected 'select "attachments"."id", …' to match /\blimit\b/i`. The 413 still fires,
 *       which is the point — the refusal was never the broken half.
 *  2b. Restore the `input.fileIds.length > 0` guard so `[]` falls through to the library branch
 *     → "an EMPTY fileIds selection archives nothing" goes red: the whole library is zipped and
 *       the adapter is opened, where the empty selection should have been a 404.
 *  3. Remove `{ maxBytes: … }` from `adapter.fetchPart` inside `downloadAll`
 *     → "hands each part the archive's REMAINING byte budget" goes red with
 *       `expected undefined to be 67108864`, which is the unbounded read exactly.
 */

const svc = new AttachmentsService();

async function seedAtt(
  db: Awaited<ReturnType<typeof makeCtx>>["db"], accountId: string, messageId: string, sizeBytes = 10,
): Promise<string> {
  const [row] = await db.insert(attachmentsTbl).values({
    accountId, messageId,
    filename: `f-${randomUUID()}.bin`,
    contentType: "application/octet-stream",
    sizeBytes, inline: false, partId: "2",
  }).returning();
  return row!.id;
}

/**
 * Record the SQL drizzle actually issues on this handle.
 *
 * `db.session.logger` is drizzle's own seam (a `NoopLogger` by default), so this observes the
 * statements the service builds rather than statements a test rebuilt to look like them. It is
 * the same kind of evidence an earlier change used for the `NaN` limit — *"Measured against drizzle
 * 0.36.4: `.limit(NaN).toSQL()` is `{sql: 'select "id" from "t"'}`"* — and it is what makes
 * "the ceiling is applied to the READ" a checkable claim rather than a comment: a refusal that
 * happens AFTER an unbounded select is indistinguishable, from the outside, from one that
 * happens before it.
 */
function recordSql(db: unknown): { queries: string[] } {
  const session = (db as { session: { logger: { logQuery(q: string, p: unknown[]): void } } }).session;
  const queries: string[] = [];
  session.logger = { logQuery: (q) => { queries.push(q); } };
  return { queries };
}

/** Records every ceiling `downloadAll` hands down, and how many parts it asked for. */
function spyAdapter(onFetch?: (opts?: { maxBytes?: number }) => Promise<{ body: Uint8Array }>) {
  const state = { opened: 0, closed: 0, fetches: 0, ceilings: [] as Array<number | undefined> };
  const openAdapter: OpenAdapter = async (): Promise<AttachmentAdapter> => {
    state.opened += 1;
    return {
      fetchPart: async (_l, _p, opts) => {
        state.fetches += 1;
        state.ceilings.push(opts?.maxBytes);
        const r = await (onFetch?.(opts) ?? Promise.resolve({ body: new Uint8Array([1, 2, 3]) }));
        return { contentType: "application/octet-stream", filename: null, body: r.body };
      },
      close: async () => { state.closed += 1; },
    };
  };
  return { openAdapter, state };
}

describe("download-all: the caller's fileIds list is bounded BEFORE it reaches the query", () => {
  it("refuses an over-long fileIds list, and never builds the predicate", async () => {
    const { ctx } = await makeCtx();
    const { openAdapter, state } = spyAdapter();
    // Well-formed uuids, so the only thing that can refuse this is the count. Postgres refuses a
    // statement over its bind-parameter ceiling; a caller who can choose this length can choose that.
    const fileIds = Array.from({ length: DOWNLOAD_ALL_MAX_PARTS + 100 }, () => randomUUID());

    const err = await svc.downloadAll(ctx, { fileIds }, { openAdapter }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(413);
    expect((err as ServiceError).code).toBe("payload_too_large");
    // The refusal NAMES the limit — a 413 that does not is a limit the caller cannot narrow to.
    expect((err as ServiceError).message).toContain(String(DOWNLOAD_ALL_MAX_PARTS));
    // And no mail server was contacted for a request that was never going to be served.
    expect(state.opened).toBe(0);
  });

  it("refuses a malformed file id as a 400, not a 500 from Postgres", async () => {
    const { ctx } = await makeCtx();
    const { openAdapter } = spyAdapter();

    const err = await svc
      .downloadAll(ctx, { fileIds: ["not-a-uuid"] }, { openAdapter })
      .catch((e: unknown) => e);

    // Untyped, this reached a `uuid` column and raised 22P02 — a 500 for a plainly bad request.
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(400);
    expect((err as ServiceError).code).toBe("validation_failed");
  });

  it("an EMPTY fileIds selection archives nothing, never the whole library", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    // A library the fall-through would have zipped. Small enough that the count ceiling cannot be
    // what refuses the request — the answer has to come from the empty SELECTION.
    for (let i = 0; i < 5; i++) await seedAtt(db, accountId, messageId);
    const { openAdapter, state } = spyAdapter();

    const err = await svc.downloadAll(ctx, { fileIds: [] }, { openAdapter }).catch((e: unknown) => e);

    // A present-but-empty `fileIds` is the SELECTION mode with nothing selected. It used to fall
    // through to the unfiltered library branch, so a client asking to archive nothing downloaded
    // the account's entire attachment history — a caller-chosen selection of zero read as
    // "everything", which is the `NaN`-limit shape one route over.
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(404);
    expect(state.opened, "nothing was selected, so no mailbox is dialled").toBe(0);
  });

  it("a list exactly AT the ceiling is served, so the bound refuses nothing legitimate", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    const real = await seedAtt(db, accountId, messageId);
    // At the ceiling: one real id plus enough well-formed strangers to reach exactly the cap.
    const fileIds = [real, ...Array.from({ length: DOWNLOAD_ALL_MAX_PARTS - 1 }, () => randomUUID())];
    const { openAdapter, state } = spyAdapter();

    const out = await svc.downloadAll(ctx, { fileIds }, { openAdapter });

    expect(out.zip.byteLength).toBeGreaterThan(0);
    expect(state.fetches).toBe(1);   // only the one that exists in this account
  });
});

describe("download-all: the unfiltered library form is bounded at the READ", () => {
  it("refuses without reading the whole library", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    // One more than the ceiling. Before the fix this read every one of them into the process
    // and then counted the array in order to answer 413.
    for (let i = 0; i <= DOWNLOAD_ALL_MAX_PARTS; i++) await seedAtt(db, accountId, messageId);
    const { openAdapter, state } = spyAdapter();
    const sql = recordSql(db);

    const err = await svc.downloadAll(ctx, { filter: {} }, { openAdapter }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(413);
    expect((err as ServiceError).message).toContain(String(DOWNLOAD_ALL_MAX_PARTS));
    expect(state.opened).toBe(0);

    // THE HALF THE STATUS CODE DOES NOT PROVE. The 413 was always correct; what was wrong was
    // that it cost a full-table read to produce. The select that resolves the targets must carry
    // a `limit`, so the refusal costs the ceiling plus one row and never the account's library.
    const targets = sql.queries.filter((q) => /from "attachments"/.test(q) && /"messages"/.test(q));
    expect(targets.length, "the target resolution should be one select").toBe(1);
    expect(targets[0], "the resolving read must be bounded, not merely refused afterwards")
      .toMatch(/\blimit\b/i);
  });

  it("a library exactly AT the ceiling still downloads — the plus-one is a sentinel, not an off-by-one", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    for (let i = 0; i < DOWNLOAD_ALL_MAX_PARTS; i++) await seedAtt(db, accountId, messageId);
    const { openAdapter, state } = spyAdapter();

    const out = await svc.downloadAll(ctx, { filter: {} }, { openAdapter });

    expect(out.zip.byteLength).toBeGreaterThan(0);
    expect(state.fetches).toBe(DOWNLOAD_ALL_MAX_PARTS);
  });
});

describe("download-all: one part cannot outweigh the whole archive", () => {
  it("hands each part the archive's REMAINING byte budget", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await seedAtt(db, accountId, messageId, 10);
    await seedAtt(db, accountId, messageId, 10);
    // Every part returns 100 bytes, so the second part's ceiling must be 100 lower than the first.
    const hundred = new Uint8Array(100);
    const { openAdapter, state } = spyAdapter(() => Promise.resolve({ body: hundred }));

    await svc.downloadAll(ctx, { messageId }, { openAdapter });

    expect(state.fetches).toBe(2);
    // THE ASSERTION THIS FILE EXISTS FOR. It used to be `fetchPart(locator, partId)` with no
    // options at all, so a part that DECLARES 10 bytes and STREAMS four gigabytes was buffered
    // whole — the running total is only consulted between parts, never during one.
    expect(state.ceilings[0]).toBe(DOWNLOAD_ALL_MAX_BYTES);
    expect(state.ceilings[1]).toBe(DOWNLOAD_ALL_MAX_BYTES - 100);
  });

  it("a mid-stream breach ends that mailbox's group and says so, rather than being retried down a poisoned socket", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const messageId = await seedMessage(db, accountId, mailboxId);
    await seedAtt(db, accountId, messageId, 10);
    await seedAtt(db, accountId, messageId, 10);
    await seedAtt(db, accountId, messageId, 10);
    const tooLarge = Object.assign(new Error("part exceeds ceiling"), { code: "EATTACHTOOLARGE" });
    const { openAdapter, state } = spyAdapter(() => Promise.reject(tooLarge));

    const out = await svc.downloadAll(ctx, { messageId }, { openAdapter });

    // ONE fetch attempted. `maxBytes` leaves the IMAP parser mid-literal, so the socket cannot be
    // used again — which is the reason the adapter's own docstring used to forbid passing it here,
    // and the reason the group is abandoned rather than the ceiling dropped.
    expect(state.fetches).toBe(1);
    expect(state.closed).toBe(1);
    // The archive still comes back, and it is HONEST about what is missing: a truncated archive
    // the user does not notice is the outcome `DOWNLOAD_ALL_MAX_PARTS`' own docstring refuses.
    // Asserting the ERRORS FILE alone would not show that — one skipped part writes one too — so
    // the count is what this checks: three parts, one attempted, and every one of them named.
    const text = Buffer.from(out.zip).toString("latin1");
    expect(text).toContain("_errors.txt");
    const named = [...text.matchAll(/f-[0-9a-f-]+\.bin/g)].length;
    expect(named, "every part of the abandoned group is named, not just the one that broke")
      .toBeGreaterThanOrEqual(3);
  });
});
