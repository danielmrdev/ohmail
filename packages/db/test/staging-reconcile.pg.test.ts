import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { accounts } from "../src/schema-mail.js";
import { attachmentStaging } from "../src/schema-cloud.js";
import {
  createStagingTicket, stagingObjectPath, stagingTicketIdOf, sweepExpiredStagingFor,
  reconcileStagingOrphansFor, reconcileStagingOrphans, StagingListingUnsupportedError,
  STAGING_ORPHAN_MIN_AGE_MS, ATTACHMENT_STAGING_TTL_MS,
  type AttachmentStagingStorage, type StagedObjectListing,
} from "../src/attachment-staging.js";

/**
 * A SIGNED UPLOAD GRANT OUTLIVES THE ERASURE THAT CLEANED UP, AND THE SWEEP CANNOT SEE WHAT IT
 * WRITES.
 *
 * The sequence, which this file drives end to end: a ticket is minted and a grant signed; the
 * erasure expires the ticket; the hourly sweep deletes the object and then the row; the still
 * valid PUT then lands. The bytes are now in the bucket with no row anywhere pointing at them —
 * and the sweep works FROM TICKETS, so it will never look at them again. They were there for the
 * life of the deployment.
 *
 * Neither shipped store can revoke a grant it has already signed (a hosted-storage upload token and an
 * object-store presigned URL are both self-contained, and nothing of ours is in the request path), so the
 * answer is the other direction: walk the objects and delete what no ticket names. Real Postgres
 * for the ticket half, because that is the half that decides, and a fake bucket for the object
 * half — the shipped listings have their own files.
 *
 * COUNTS ONLY, here as in the pass: an object path names an account and a ticket.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof brandDialect<ReturnType<typeof drizzle>>>;

const NOW = new Date("2026-09-14T12:00:00.000Z");
/** Old enough to judge: one minute past the derived bound. */
const LONG_AGO = new Date(NOW.getTime() - STAGING_ORPHAN_MIN_AGE_MS - 60_000);

/** A bucket, in memory: the objects and what the walk says about each. */
function fakeBucket(objects: StagedObjectListing[]): AttachmentStagingStorage & {
  paths(): string[]; removed: string[];
} {
  const held = new Map(objects.map((o) => [o.objectPath, o]));
  const removed: string[] = [];
  return {
    removed,
    paths: () => [...held.keys()].sort(),
    async signUpload() { return { uploadUrl: "u", uploadMethod: "PUT", uploadHeaders: {} }; },
    async download() { return new Uint8Array(); },
    async remove(paths) {
      for (const p of paths) { held.delete(p); removed.push(p); }
    },
    async list(cursor, limit) {
      const all = [...held.values()].sort((a, b) => (a.objectPath < b.objectPath ? -1 : 1));
      const from = cursor === null ? 0 : Number.parseInt(cursor, 10);
      const page = all.slice(from, from + limit);
      const next = from + page.length;
      return { objects: page, cursor: next >= all.length ? null : String(next) };
    },
  };
}

async function seedAccount(): Promise<string> {
  const [a] = await db.insert(accounts).values({ name: "staging reconcile" }).returning();
  return a!.id;
}

describe.skipIf(!PG_UP)("the bytes a signed grant writes after the erasure", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client), "pg");
  }, 180_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("mint, erase, sweep, then the late PUT: the orphan is found and deleted", async () => {
    const accountId = await seedAccount();
    const ticketId = randomUUID();
    const path = stagingObjectPath(accountId, ticketId);
    await createStagingTicket(db as never, {
      id: ticketId, accountId, objectPath: path, filename: "f", contentType: "application/pdf",
      sizeBytes: 10, now: LONG_AGO,
    });

    // THE ERASURE expires the ticket — what `deleteAccount` does — and the hourly sweep then
    // removes the object (there is none yet: the upload is still in flight) and the row.
    await db.update(attachmentStaging).set({ expiresAt: LONG_AGO })
      .where(eq(attachmentStaging.id, ticketId));
    const bucketDuringSweep = fakeBucket([]);
    await sweepExpiredStagingFor(db as never, bucketDuringSweep, NOW);
    expect(await db.select().from(attachmentStaging)
      .where(eq(attachmentStaging.id, ticketId))).toHaveLength(0);

    // AND NOW THE PUT LANDS. Nothing knows these bytes exist.
    const bucket = fakeBucket([{ objectPath: path, lastModifiedAt: LONG_AGO, sizeBytes: 10 }]);
    const sweptAgain = await sweepExpiredStagingFor(db as never, bucket, NOW);
    expect(sweptAgain.deleted, "the expiry sweep cannot see an object with no ticket").toBe(0);
    expect(bucket.paths(), "and it leaves it exactly where it is").toHaveLength(1);

    const rec = await reconcileStagingOrphansFor(db as never, bucket, NOW);
    expect(rec.orphans).toBe(1);
    expect(rec.deleted).toBe(1);
    expect(rec.complete).toBe(true);
    expect(bucket.paths()).toHaveLength(0);
  }, 60_000);

  it("POSITIVE CONTROL: an ordinary upload is left alone while its ticket lives, and swept with it",
    async () => {
      const accountId = await seedAccount();
      const ticketId = randomUUID();
      const path = stagingObjectPath(accountId, ticketId);
      // Minted long ago so AGE cannot be what spares it — the ticket is what spares it.
      await createStagingTicket(db as never, {
        id: ticketId, accountId, objectPath: path, filename: "f", contentType: "application/pdf",
        sizeBytes: 10, now: LONG_AGO,
      });
      await db.update(attachmentStaging)
        .set({ expiresAt: new Date(NOW.getTime() + ATTACHMENT_STAGING_TTL_MS) })
        .where(eq(attachmentStaging.id, ticketId));
      const bucket = fakeBucket([{ objectPath: path, lastModifiedAt: LONG_AGO, sizeBytes: 10 }]);

      const rec = await reconcileStagingOrphansFor(db as never, bucket, NOW);
      expect(rec.scanned).toBeGreaterThanOrEqual(1);
      expect(rec.orphans, "a live ticket's object was deleted").toBe(0);
      expect(bucket.paths()).toEqual([path]);

      // And the ordinary end: the ticket expires, the sweep takes object and row together.
      await db.update(attachmentStaging).set({ expiresAt: LONG_AGO })
        .where(eq(attachmentStaging.id, ticketId));
      const swept = await sweepExpiredStagingFor(db as never, bucket, NOW);
      expect(swept.deleted).toBe(1);
      expect(bucket.paths()).toHaveLength(0);
    }, 60_000);

  it("spares an object too YOUNG to judge, which is what keeps it off a live mint", async () => {
    const accountId = await seedAccount();
    // No ticket row at all — the harshest case — but the bytes were written a minute ago, which
    // is what an upload racing this walk looks like.
    const path = stagingObjectPath(accountId, randomUUID());
    const bucket = fakeBucket([{
      objectPath: path, lastModifiedAt: new Date(NOW.getTime() - 60_000), sizeBytes: 10,
    }]);

    const rec = await reconcileStagingOrphansFor(db as never, bucket, NOW);
    expect(rec.orphans).toBe(0);
    expect(bucket.paths()).toEqual([path]);
  }, 60_000);

  it("counts an object it cannot date, and one whose path is not ours, and deletes neither",
    async () => {
      const accountId = await seedAccount();
      const undated = stagingObjectPath(accountId, randomUUID());
      const bucket = fakeBucket([
        { objectPath: undated, lastModifiedAt: null, sizeBytes: 1 },
        { objectPath: "somebody-elses-object.bin", lastModifiedAt: LONG_AGO, sizeBytes: 1 },
      ]);

      const rec = await reconcileStagingOrphansFor(db as never, bucket, NOW);
      expect(rec.orphans, "no timestamp is not the same as old").toBe(0);
      expect(rec.unrecognised).toBe(1);
      expect(bucket.paths()).toHaveLength(2);
    }, 60_000);

  it("DRY RUN judges everything and removes nothing — the read-only count's own mode", async () => {
    const accountId = await seedAccount();
    const path = stagingObjectPath(accountId, randomUUID());
    const bucket = fakeBucket([{ objectPath: path, lastModifiedAt: LONG_AGO, sizeBytes: 10 }]);

    const rec = await reconcileStagingOrphansFor(db as never, bucket, NOW, { dryRun: true });
    expect(rec.orphans).toBe(1);
    expect(rec.deleted).toBe(0);
    expect(bucket.removed).toEqual([]);
    expect(bucket.paths()).toEqual([path]);
  }, 60_000);

  it("refuses BY NAME on a store that cannot list its own bucket", async () => {
    const bucket = fakeBucket([]);
    const { list: _list, ...blind } = bucket;
    await expect(reconcileStagingOrphans({
      storage: blind as AttachmentStagingStorage, now: NOW,
      async ticketsPresent() { return new Set(); },
    })).rejects.toBeInstanceOf(StagingListingUnsupportedError);
  });

  it("reads a ticket id only out of a path this deployment writes", () => {
    const a = randomUUID();
    const t = randomUUID();
    expect(stagingTicketIdOf(stagingObjectPath(a, t))).toBe(t);
    expect(stagingTicketIdOf(`${a}/${t}/extra`)).toBeNull();
    expect(stagingTicketIdOf("logo.png")).toBeNull();
    expect(stagingTicketIdOf(`${a}/not-a-uuid`)).toBeNull();
  });
});
