import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq, inArray } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, attachments, auditLog, changeLog, mailboxes, messages } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import {
  runAttachmentFlagBackfill, planAttachmentFlagBackfill,
} from "../src/attachment-flag-backfill.js";
import type { Db } from "../src/context.js";

/**
 * THE `has_attachments` BACKFILL, AGAINST REAL POSTGRES.
 *
 * ── WHY `.pg.test.ts` AND WHY PGLITE WOULD NOT COUNT ───────────────────────────────────────
 *
 * The pass rewrites a display flag on many rows of a live mailbox while the worker is
 * ingesting into the same table. Two of its claims are green-by-construction under PGlite, which
 * is single-connection:
 *
 *  · `SELECT … FOR UPDATE OF messages` is a no-op there and always succeeds, so "corrected once,
 *    one change_log row, not two" would pass without ever being tested. Three production bugs in
 *    this repository were invisible to PGlite and appeared only on :5433, all of this class.
 *  · `allocateSeq`'s gap-free per-account sequence under two writers — this pass takes a
 *    `messages` row lock BEFORE the seq lock, which is exactly how a lock-order deadlock gets
 *    introduced.
 *
 * The pure-logic cases live here too rather than in a second PGlite file, so one seeding helper
 * describes the MIME shapes and the two engines cannot come to disagree about them.
 */

const AVAILABLE = await realPgAvailable();

interface World { accountId: string; mailboxId: string }

describe.skipIf(!AVAILABLE)("the attachment-flag backfill", () => {
  let db: Db;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // Four connections minimum, or the "concurrent" transactions queue in the POOL and the
    // concurrency case proves nothing about the database.
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Db;
  }, 120_000);

  async function newWorld(): Promise<World> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `at1-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `at1-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  /**
   * One message plus its attachment rows, seeded with the pair ingest USED to write:
   * `has_attachments = parts.length > 0`, `attachment_count = parts.length`. That is the defect
   * being corrected, so the fixture has to reproduce it rather than the fixed value.
   */
  async function seed(w: World, parts: Array<{ inline: boolean; name?: string }>): Promise<string> {
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h",
      dedupKey: `at1:${randomUUID()}`, subject: "s", fromAddress: "sender@example.test",
      nativeLocator: { folder: "INBOX", ref: `1:${Math.floor(Math.random() * 1e6)}` },
      hasAttachments: parts.length > 0,
      attachmentCount: parts.length,
    }).returning();
    for (const [i, p] of parts.entries()) {
      await db.insert(attachments).values({
        accountId: w.accountId, messageId: m!.id,
        filename: p.name ?? (p.inline ? `logo${i}.gif` : `file${i}.pdf`),
        contentType: p.inline ? "image/gif" : "application/pdf",
        sizeBytes: 1024, partId: String(i + 2),
        contentId: p.inline ? `cid${i}@corp` : null,
        inline: p.inline,
      });
    }
    return m!.id;
  }

  const pairOf = async (id: string) => {
    const [r] = await db.select({
      has: messages.hasAttachments, count: messages.attachmentCount,
    }).from(messages).where(eq(messages.id, id));
    return { has: r!.has, count: r!.count };
  };

  const changesFor = async (accountId: string, ids: string[]) =>
    db.select().from(changeLog).where(and(
      eq(changeLog.accountId, accountId), inArray(changeLog.entityId, ids),
    ));

  /* ── THE HEADLINE CASE ─────────────────────────────────────────────────────────────────── */

  it("clears a message whose only parts are inline, and emits ONE message/update change", async () => {
    const w = await newWorld();
    const id = await seed(w, [{ inline: true }, { inline: true }]);
    expect(await pairOf(id)).toEqual({ has: true, count: 2 });

    const r = await runAttachmentFlagBackfill({ db, mailboxId: w.mailboxId });

    expect(r).toMatchObject({ examined: 1, cleared: 1, recounted: 0, truncated: false });
    expect(await pairOf(id)).toEqual({ has: false, count: 0 });

    // The delta is the half of the fix the user can actually see. Without it their mirror keeps
    // the paperclip for ever.
    const changes = await changesFor(w.accountId, [id]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ entityType: "message", entityId: id, op: "update" });
  });

  it("KEEPS the flag for one real file among three inline images, and recounts 4 -> 1", async () => {
    const w = await newWorld();
    const id = await seed(w, [
      { inline: true }, { inline: true }, { inline: true },
      { inline: false, name: "invoice.pdf" },
    ]);
    expect(await pairOf(id)).toEqual({ has: true, count: 4 });

    const r = await runAttachmentFlagBackfill({ db, mailboxId: w.mailboxId });

    expect(r).toMatchObject({ examined: 1, cleared: 0, recounted: 1, truncated: false });
    // The paperclip STAYS. A pass that cleared this would be a regression dressed as a fix.
    expect(await pairOf(id)).toEqual({ has: true, count: 1 });
  });

  /* ── WHAT IT MUST NOT TOUCH ────────────────────────────────────────────────────────────── */

  it("does not touch a row whose pair is already correct — no write, no change, no audit", async () => {
    const w = await newWorld();
    const [correct] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h",
      dedupKey: `at1:${randomUUID()}`, subject: "s", fromAddress: "sender@example.test",
      nativeLocator: { folder: "INBOX", ref: "1:9" },
      hasAttachments: true, attachmentCount: 1,
    }).returning();
    await db.insert(attachments).values({
      accountId: w.accountId, messageId: correct!.id, filename: "real.pdf",
      contentType: "application/pdf", sizeBytes: 10, partId: "2", inline: false,
    });

    const r = await runAttachmentFlagBackfill({ db, mailboxId: w.mailboxId });

    expect(r).toMatchObject({ examined: 0, cleared: 0, recounted: 0 });
    expect(await pairOf(correct!.id)).toEqual({ has: true, count: 1 });
    expect(await changesFor(w.accountId, [correct!.id])).toHaveLength(0);
    // Not even the terminal receipt: nothing was touched, so nothing is recorded.
    const audits = await db.select().from(auditLog).where(eq(auditLog.accountId, w.accountId));
    expect(audits).toHaveLength(0);
  });

  it("leaves an unflagged message alone even though it holds a real file", async () => {
    // Production measured ZERO of these, which is why the pass is gated on `has_attachments`.
    // If the measurement ever stops holding, this test documents that the pass does NOT cover it.
    const w = await newWorld();
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h",
      dedupKey: `at1:${randomUUID()}`, subject: "s", fromAddress: "sender@example.test",
      nativeLocator: { folder: "INBOX", ref: "1:11" },
      hasAttachments: false, attachmentCount: 0,
    }).returning();
    await db.insert(attachments).values({
      accountId: w.accountId, messageId: m!.id, filename: "orphan.pdf",
      contentType: "application/pdf", sizeBytes: 10, partId: "2", inline: false,
    });

    const r = await runAttachmentFlagBackfill({ db, mailboxId: w.mailboxId });

    expect(r.examined).toBe(0);
    expect(await pairOf(m!.id)).toEqual({ has: false, count: 0 });
  });

  /* ── IDEMPOTENCE ───────────────────────────────────────────────────────────────────────── */

  it("is idempotent: a second run examines nothing and writes nothing", async () => {
    const w = await newWorld();
    const inlineOnly = await seed(w, [{ inline: true }]);
    const mixed = await seed(w, [{ inline: true }, { inline: false }]);

    const first = await runAttachmentFlagBackfill({ db, mailboxId: w.mailboxId });
    expect(first).toMatchObject({ examined: 2, cleared: 1, recounted: 1, truncated: false });

    const changesAfterFirst = await changesFor(w.accountId, [inlineOnly, mixed]);
    const auditsAfterFirst = await db.select().from(auditLog)
      .where(eq(auditLog.accountId, w.accountId));

    const second = await runAttachmentFlagBackfill({ db, mailboxId: w.mailboxId });

    // The candidate query IS the idempotency — a corrected row is no longer a candidate, so the
    // second run does not even read it. `examined: 0` is a stronger claim than "wrote nothing".
    expect(second).toMatchObject({ examined: 0, cleared: 0, recounted: 0, truncated: false });
    expect(await changesFor(w.accountId, [inlineOnly, mixed])).toHaveLength(changesAfterFirst.length);
    expect(await db.select().from(auditLog).where(eq(auditLog.accountId, w.accountId)))
      .toHaveLength(auditsAfterFirst.length);
    expect(await pairOf(inlineOnly)).toEqual({ has: false, count: 0 });
    expect(await pairOf(mixed)).toEqual({ has: true, count: 1 });
  });

  /* ── THE AUDIT TRAIL ───────────────────────────────────────────────────────────────────── */

  it("records an inverse carrying the PRIOR pair, plus one terminal receipt", async () => {
    const w = await newWorld();
    const id = await seed(w, [{ inline: true }, { inline: true }, { inline: true }]);

    await runAttachmentFlagBackfill({ db, mailboxId: w.mailboxId });

    const rows = await db.select().from(auditLog).where(eq(auditLog.accountId, w.accountId));
    const perRow = rows.filter((r) => r.action === "attachment_flag_backfill_row");
    const summary = rows.filter((r) => r.action === "attachment_flag_backfill");

    expect(perRow).toHaveLength(1);
    // BOTH fields. An inverse restoring only the flag would leave the count at the new value —
    // that is a third state, not an undo.
    expect(perRow[0]!.inverse).toEqual({
      messageId: id, hasAttachments: true, attachmentCount: 3,
    });
    expect(perRow[0]!.payload).toMatchObject({ hasAttachments: false, attachmentCount: 0 });

    // The terminal row is what a marker column would have been: this pass adds no schema.
    expect(summary).toHaveLength(1);
    expect(summary[0]!.payload).toMatchObject({ examined: 1, cleared: 1, recounted: 0 });
    expect(summary[0]!.inverse).toBeNull();
  });

  /* ── RESUMABILITY ──────────────────────────────────────────────────────────────────────── */

  it("resumes after a truncated run and finishes the set", async () => {
    const w = await newWorld();
    for (let i = 0; i < 5; i++) await seed(w, [{ inline: true }]);

    // One row per page, one page: deliberately truncated mid-set.
    const partial = await runAttachmentFlagBackfill({
      db, mailboxId: w.mailboxId, batch: 1, maxPages: 2,
    });
    expect(partial.truncated).toBe(true);
    expect(partial.cleared).toBe(2);

    const rest = await runAttachmentFlagBackfill({ db, mailboxId: w.mailboxId });
    expect(rest).toMatchObject({ cleared: 3, truncated: false });

    const remaining = await db.select().from(messages)
      .where(and(eq(messages.mailboxId, w.mailboxId), eq(messages.hasAttachments, true)));
    expect(remaining).toHaveLength(0);
  });

  /* ── SCOPE ─────────────────────────────────────────────────────────────────────────────── */

  it("--mailbox confines the pass to one mailbox", async () => {
    const a = await newWorld();
    const b = await newWorld();
    const inA = await seed(a, [{ inline: true }]);
    const inB = await seed(b, [{ inline: true }]);

    await runAttachmentFlagBackfill({ db, mailboxId: a.mailboxId });

    expect(await pairOf(inA)).toEqual({ has: false, count: 0 });
    expect(await pairOf(inB)).toEqual({ has: true, count: 1 });
  });

  /* ── THE PLAN IS READ-ONLY ─────────────────────────────────────────────────────────────── */

  it("plan reports the split and writes nothing", async () => {
    const w = await newWorld();
    await seed(w, [{ inline: true }]);                          // inline-only
    await seed(w, [{ inline: true }, { inline: false }]);       // miscounted
    const [ok] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h",
      dedupKey: `at1:${randomUUID()}`, subject: "s", fromAddress: "sender@example.test",
      nativeLocator: { folder: "INBOX", ref: "1:31" },
      hasAttachments: true, attachmentCount: 1,
    }).returning();
    await db.insert(attachments).values({
      accountId: w.accountId, messageId: ok!.id, filename: "real.pdf",
      contentType: "application/pdf", sizeBytes: 10, partId: "2", inline: false,
    });

    const rows = (await planAttachmentFlagBackfill(db)).filter((r) => r.mailboxId === w.mailboxId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ flagged: 3, inlineOnly: 1, miscounted: 1, correct: 1 });
    // Read-only means read-only: nothing moved.
    expect(await db.select().from(changeLog).where(eq(changeLog.accountId, w.accountId)))
      .toHaveLength(0);
  });

  /* ── CONCURRENCY: THE REASON THIS FILE IS `.pg.test.ts` ────────────────────────────────── */

  it("two concurrent runs correct each message ONCE — one change_log row, one audit row", async () => {
    const w = await newWorld();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await seed(w, [{ inline: true }, { inline: true }]));

    // Both runs walk the same candidate set at the same time on separate connections. The loser
    // blocks on `FOR UPDATE OF messages`, re-reads the committed row, and finds the pair already
    // correct — so it neither UPDATEs, nor allocates a seq, nor writes an audit row.
    const [x, y] = await Promise.all([
      runAttachmentFlagBackfill({ db, mailboxId: w.mailboxId, batch: 4 }),
      runAttachmentFlagBackfill({ db, mailboxId: w.mailboxId, batch: 4 }),
    ]);

    expect(x.cleared + y.cleared).toBe(12);

    for (const id of ids) expect(await pairOf(id)).toEqual({ has: false, count: 0 });

    // ONE delta per message. Two would be a the "Delta-first client contract" invariant convergence break: the client told the same
    // message changed twice at two different seqs, having only changed once.
    const changes = await changesFor(w.accountId, ids);
    expect(changes).toHaveLength(12);
    expect(new Set(changes.map((c) => c.entityId)).size).toBe(12);

    // …and the seq allocation stays gap-free and unique under both writers.
    const seqs = changes.map((c) => Number(c.seq));
    expect(new Set(seqs).size).toBe(12);

    const perRow = (await db.select().from(auditLog).where(eq(auditLog.accountId, w.accountId)))
      .filter((r) => r.action === "attachment_flag_backfill_row");
    expect(perRow).toHaveLength(12);
  });
});
