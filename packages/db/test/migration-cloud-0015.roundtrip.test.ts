import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { accounts } from "../src/schema.js";
import { attachmentStaging } from "../src/schema-cloud.js";
import {
  createStagingTicket, readStagingTickets, expiredStagingTickets, deleteStagingTickets,
  attachmentStagingExpiry, ATTACHMENT_STAGING_TTL_MS,
} from "../src/attachment-staging.js";

/**
 * Proves CLOUD migration 0015 (`attachment_staging`) persists its four artifacts — the table, the
 * unique object path, and the two indexes the reads and the sweep depend on — and that the four
 * statements anything runs against it behave as their headers claim.
 *
 * ## Why the UNIQUE is the one worth a named test
 *
 * `object_path` is the DELETE KEY: the sweep removes the object and then the row, as a pair. Two
 * rows naming one object would leave a live ticket pointing at bytes another ticket's expiry
 * already deleted — a send that reads a ticket, finds nothing, and refuses a message whose file
 * was there an hour ago. The constraint is what makes that unrepresentable, and a name-only census
 * cannot tell a table with it from a table without.
 *
 * ## The reads are ACCOUNT-SCOPED in the module, not at the call site
 *
 * A staging id is a bearer of somebody's outgoing attachment bytes. The scoping test below is the
 * one that says a foreign id produces nothing rather than a row — which is also what makes "not
 * yours" and "never existed" one answer at every caller, and therefore not an existence oracle.
 *
 * Replays into PGlite via `makeTestDb` (both journals). The SWEEP's ordering against real
 * Postgres, including the abandoned-upload case, is `attachment-staging.pg.test.ts`.
 */
describe("cloud migration 0015 round-trip (attachment_staging)", () => {
  type Db = Awaited<ReturnType<typeof makeTestDb>>;
  const NOW = new Date("2026-08-13T12:00:00Z");

  async function seedAccount(db: Db): Promise<string> {
    const [acct] = await db.insert(accounts).values({ name: "cloud migration" }).returning();
    return acct!.id;
  }
  const ticket = (accountId: string, over: Partial<{
    id: string; objectPath: string; filename: string; contentType: string;
    sizeBytes: number; now: Date;
  }> = {}) => ({
    id: over.id ?? randomUUID(),
    accountId,
    objectPath: over.objectPath ?? `${accountId}/${randomUUID()}`,
    filename: over.filename ?? "holiday.mov",
    contentType: over.contentType ?? "video/quicktime",
    sizeBytes: over.sizeBytes ?? 6 * 1024 * 1024,
    now: over.now ?? NOW,
  });

  it("the table and its three constraints exist", async () => {
    const db = await makeTestDb();
    const cols = await db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'attachment_staging'
       order by column_name`);
    const rows = Array.isArray(cols) ? cols : (cols as unknown as { rows: { column_name: string }[] }).rows;
    // `content_sha256` is cloud 0041's, not 0015's — this list is the table as it stands, and a
    // later migration's column has to arrive here or the list stops being a reading of the table.
    expect((rows as { column_name: string }[]).map((r) => r.column_name)).toEqual([
      "account_id", "content_sha256", "content_type", "created_at", "expires_at", "filename", "id",
      "object_path", "size_bytes",
    ]);

    const idx = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
       where schemaname = 'public' and tablename = 'attachment_staging'
       order by indexname`);
    const irows = Array.isArray(idx) ? idx : (idx as unknown as { rows: { indexname: string }[] }).rows;
    const names = (irows as { indexname: string }[]).map((r) => r.indexname);
    expect(names).toContain("attachment_staging_object_path_unique");
    expect(names).toContain("attachment_staging_account_idx");
    expect(names).toContain("attachment_staging_expires_idx");
  });

  it("TWO ROWS MAY NOT NAME ONE OBJECT — the delete key, enforced by the table", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    const path = `${a}/shared`;
    await createStagingTicket(db, ticket(a, { objectPath: path }));
    await expect(createStagingTicket(db, ticket(a, { objectPath: path }))).rejects.toThrow();
  });

  it("a ticket is born with the 24-hour retention promise on the row", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    const row = await createStagingTicket(db, ticket(a));
    expect(row.expiresAt.getTime()).toBe(NOW.getTime() + ATTACHMENT_STAGING_TTL_MS);
    expect(attachmentStagingExpiry(NOW).getTime()).toBe(row.expiresAt.getTime());
    // The declared size survives the round trip as a NUMBER, not a bigint string — the send adds
    // these up to refuse an over-cap total, and string concatenation would be a silent pass.
    expect(row.sizeBytes).toBe(6 * 1024 * 1024);
    expect(typeof row.sizeBytes).toBe("number");
  });

  it("the reads are ACCOUNT-SCOPED: another account's id is simply absent", async () => {
    const db = await makeTestDb();
    const mine = await seedAccount(db);
    const theirs = await seedAccount(db);
    const a = await createStagingTicket(db, ticket(mine));
    const b = await createStagingTicket(db, ticket(theirs));

    const got = await readStagingTickets(db, mine, [a.id, b.id]);
    expect(got.map((r) => r.id)).toEqual([a.id]);
    // …and asking for nothing costs no query and answers nothing.
    expect(await readStagingTickets(db, mine, [])).toEqual([]);
  });

  it("EXPIRY IS NOT FILTERED BY THE READ — the send must be able to say 'that expired'", async () => {
    // A filter here would collapse "your upload expired" and "that was never yours" into one
    // 404, and only the first tells the user what to do about it.
    const db = await makeTestDb();
    const a = await seedAccount(db);
    const old = await createStagingTicket(db, ticket(a, {
      now: new Date(NOW.getTime() - 2 * ATTACHMENT_STAGING_TTL_MS),
    }));
    const got = await readStagingTickets(db, a, [old.id]);
    expect(got).toHaveLength(1);
    expect(got[0]!.expiresAt.getTime()).toBeLessThan(NOW.getTime());
  });

  it("the sweep's selection takes the AGED-OUT ones, oldest first, bounded", async () => {
    const db = await makeTestDb();
    const a = await seedAccount(db);
    const dayAgo = new Date(NOW.getTime() - ATTACHMENT_STAGING_TTL_MS - 60_000);
    const twoDaysAgo = new Date(NOW.getTime() - 2 * ATTACHMENT_STAGING_TTL_MS);
    const older = await createStagingTicket(db, ticket(a, { now: twoDaysAgo }));
    const old = await createStagingTicket(db, ticket(a, { now: dayAgo }));
    const live = await createStagingTicket(db, ticket(a, { now: NOW }));

    const expired = await expiredStagingTickets(db, NOW, 10);
    expect(expired.map((r) => r.id)).toEqual([older.id, old.id]);
    expect(expired.map((r) => r.id)).not.toContain(live.id);

    // The bound is real: the sweep runs in the worker's serial maintenance slot, so an unbounded
    // first pass would hold that slot against a mailbox that wants to sync.
    expect(await expiredStagingTickets(db, NOW, 1)).toHaveLength(1);

    expect(await deleteStagingTickets(db, expired.map((r) => r.id))).toBe(2);
    expect(await deleteStagingTickets(db, [])).toBe(0);
    const left = await db.select().from(attachmentStaging);
    expect(left.map((r) => r.id)).toEqual([live.id]);
  });
});
