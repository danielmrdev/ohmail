import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { accounts } from "@trafficflow/db";
import { schema, attachmentStaging, type AttachmentStagingStorage } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { makeAttachmentStagingPort, ServiceError } from "../src/index.js";

/**
 * SEC3-MONEY-2, SEND-FACING HALF — WHAT A CALLER AT QUOTA IS ACTUALLY TOLD.
 *
 * The bound itself, its lock and its arithmetic live in `@trafficflow/db/cloud` and are guarded in
 * `packages/db/test/attachment-staging-quota.pg.test.ts`. What is decided HERE is the half that is
 * service-shaped, and it is not cosmetic — two things in it are load-bearing:
 *
 *  · **`retryable: false` on a 429.** The engine reads
 *    `wire.error.retryable ?? (status >= 500 || status === 429)`
 *    (`packages/client-engine/src/adapters/http-adapter.ts`), so a bare 429 tells its mutation
 *    queue to try again. This is the one 429 in the product where trying again is exactly wrong:
 *    a staged ticket has no `consumed_at` and nothing but time releases it, so a retry loop would
 *    spin against a wall for up to twenty-four hours.
 *  · **The row is not written.** A refusal that left a ticket behind would be the defect with an
 *    error message attached — it would consume the very quota it just refused.
 *
 * REAL POSTGRES because the mint is now a TRANSACTION (an advisory lock, an aggregate, an insert),
 * and the claim "the refusal wrote nothing" is a claim about a transaction that really rolled back.
 *
 * Mutation watched: return the refusal as a 429 without the explicit `retryable` → the client's
 * status heuristic turns it into a retry, and the assertion on the field goes red.
 */
const PG_UP = await realPgAvailable();

const client = postgres(PG_TEST_URL, { max: 3, onnotice: () => {} });
const db = brandDialect(drizzle(client, { schema }), "pg");

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);

/**
 * EVERY ACCOUNT THIS FILE CREATES. The :5433 Postgres is shared and long-lived, so a fixture that
 * leaves rows behind permanently changes what every other suite's database-global assertions see —
 * the failure this slice fixed on `mailbox-smtp-max-size.pg.test.ts`.
 */
const created: string[] = [];

afterAll(async () => {
  if (PG_UP && created.length > 0) {
    // Child rows first — `attachment_staging.account_id` carries a foreign key. Through drizzle's
    // `inArray` rather than a `= any(${ids})` template: drizzle expands a JS array in a `sql`
    // template as a ROW constructor, so the cast reads `cannot cast type record to uuid[]`.
    await db.delete(attachmentStaging).where(inArray(attachmentStaging.accountId, created));
    await db.delete(accounts).where(inArray(accounts.id, created));
  }
  await client.end({ timeout: 5 }).catch(() => { /* already down */ });
});

const NOW = new Date("2026-08-14T12:00:00Z");

/** A bucket that records what it was asked to sign. No network, ever. */
function fakeStorage() {
  const signed: string[] = [];
  const storage: AttachmentStagingStorage = {
    async signUpload(objectPath) {
      signed.push(objectPath);
      return {
        uploadUrl: `https://storage.example/${objectPath}?token=t`,
        uploadMethod: "PUT",
        uploadHeaders: { "x-upsert": "false" },
      };
    },
    async download() { throw new Error("unused"); },
    async remove() { /* unused */ },
  };
  return { storage, signed };
}

async function seedAccount(): Promise<string> {
  const rows = await db.execute(sql`
    insert into accounts (name) values ('staging-quota-svc') returning id
  `);
  const id = (rows as unknown as Array<{ id: string }>)[0]!.id;
  created.push(id);       // see `afterAll` — this database outlives the run
  return id;
}

const armed = (quota: { maxTickets: number; maxBytes: number }) => {
  const bucket = fakeStorage();
  const port = makeAttachmentStagingPort({
    db: db as unknown as Parameters<typeof makeAttachmentStagingPort>[0]["db"],
    storage: bucket.storage,
    quota,
  });
  return { port, bucket };
};

const mint = (
  port: ReturnType<typeof armed>["port"], accountId: string, sizeBytes = 1,
  idempotencyKey = randomUUID(),
) => port.mint({
  accountId, filename: `${randomUUID()}.bin`, contentType: "application/octet-stream",
  sizeBytes, now: NOW, idempotencyKey,
});

describe.skipIf(!PG_UP)("the mint at quota — the status, the copy, and the row that is not written", () => {
  it("refuses with 429 `staging_quota_exceeded` and `retryable: false`", async () => {
    const { port } = armed({ maxTickets: 2, maxBytes: 1_000_000 });
    const accountId = await seedAccount();
    await mint(port, accountId);
    await mint(port, accountId);

    const err = await mint(port, accountId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    const se = err as ServiceError;
    expect(se.httpStatus).toBe(429);
    expect(se.code).toBe("staging_quota_exceeded");
    // THE FIELD THE CLIENT'S DEFAULT WOULD GET WRONG. Without it the engine retries a refusal
    // only time can lift.
    expect(se.retryable).toBe(false);
  });

  it("the message NAMES THE NUMBERS and the remedy that actually works", async () => {
    const { port } = armed({ maxTickets: 2, maxBytes: 1_000_000 });
    const accountId = await seedAccount();
    await mint(port, accountId);
    await mint(port, accountId);
    const se = await mint(port, accountId).catch((e: unknown) => e) as ServiceError;

    expect(se.message).toContain("2");
    // The remedy is WAITING, not sending. Saying "send the messages you have composed" would read
    // better and would be false: a send does not release a ticket, deliberately, so that a send
    // retried under the same idempotency key still finds its bytes.
    expect(se.message).toContain("24 hours");
    expect(se.message).not.toMatch(/send the messages you/i);
    expect(se.details).toMatchObject({ limit: "tickets", cap: 2, outstanding: 2 });
  });

  it("the BYTE limit is a different sentence — the two situations are not one opaque 429", async () => {
    const { port } = armed({ maxTickets: 1_000, maxBytes: 5_000 });
    const accountId = await seedAccount();
    await mint(port, accountId, 4_000);
    const se = await mint(port, accountId, 2_000).catch((e: unknown) => e) as ServiceError;
    expect(se.httpStatus).toBe(429);
    expect(se.details).toMatchObject({ limit: "bytes", cap: 5_000, outstanding: 4_000 });
    expect(se.message).toContain("5000");
  });

  it("A REFUSED MINT WRITES NO ROW AND SIGNS NO URL — the transaction rolled back", async () => {
    // Both halves matter. A row would consume the quota it was just refused for; a signed URL
    // would be an object nothing knows the path of, which the module header calls the one order
    // that leaks — the sweep could never find it and it would live for the life of the deployment.
    const { port, bucket } = armed({ maxTickets: 1, maxBytes: 1_000_000 });
    const accountId = await seedAccount();
    await mint(port, accountId);
    expect(bucket.signed).toHaveLength(1);

    await expect(mint(port, accountId)).rejects.toThrow(ServiceError);
    expect(bucket.signed).toHaveLength(1);
    const rows = await db.execute(sql`
      select count(*)::int as n from attachment_staging where account_id = ${accountId}::uuid
    `);
    expect((rows as unknown as Array<{ n: number }>)[0]!.n).toBe(1);
  });

  it("under the SHIPPED quota an ordinary compose is untouched", async () => {
    // The bound has to be invisible to honest use or it is a product regression wearing a
    // security fix. This is a large message by any measure — twenty files of 5 MB, well past the
    // 3 MB threshold at which the staged transport engages at all — minted with the real defaults.
    const port = makeAttachmentStagingPort({
      db: db as unknown as Parameters<typeof makeAttachmentStagingPort>[0]["db"],
      storage: fakeStorage().storage,
    });
    const accountId = await seedAccount();
    for (let i = 0; i < 20; i += 1) {
      const grant = await mint(port, accountId, 5 * 1024 * 1024);
      expect(grant.id).toBeTruthy();
    }
  });
});

/**
 * ═══ THE PORT SPENDS THE CALLER'S KEY ON THE TICKET'S IDENTITY ═════════════════════════════
 *
 * The uniqueness property itself is guarded in
 * `packages/db/test/attachment-staging-idempotency.pg.test.ts`. What is decided HERE is the
 * COMPOSITION — that the port derives the id from the caller's key and derives the object path
 * from that id, rather than minting a random one and hoping the row is never asked for twice.
 * Two separate things, and the port is the only place they are put together.
 */
describe.skipIf(!PG_UP)("the port's mint is keyed by the caller, not by a fresh random", () => {
  /**
   * WATCHED RED by making `mint` call `newId()` unconditionally: two grants, two object paths,
   * two rows, and a second copy of the bytes in the bucket — the defect this closes.
   */
  it("a retry under the same key returns the SAME grant and writes one row", async () => {
    const { port, bucket } = armed({ maxTickets: 50, maxBytes: 1_000_000 });
    const accountId = await seedAccount();
    const key = "send-xyz:att:0";

    const first = await port.mint({
      accountId, filename: "holiday.mov", contentType: "video/quicktime",
      sizeBytes: 4_096, now: NOW, idempotencyKey: key,
    });
    const second = await port.mint({
      accountId, filename: "holiday.mov", contentType: "video/quicktime",
      sizeBytes: 4_096, now: NOW, idempotencyKey: key,
    });

    expect(second.id).toBe(first.id);
    expect(second.expiresAt).toBe(first.expiresAt);
    const rows = await db.select().from(attachmentStaging)
      .where(inArray(attachmentStaging.accountId, [accountId]));
    expect(rows, "the retry wrote a second ticket").toHaveLength(1);

    // A FRESH GRANT FOR THE SAME OBJECT. Signing is not a write and the URL has a lifetime of its
    // own, so a replay signs again rather than replaying a stale one — and it signs the path the
    // FIRST attempt was given, which is what makes the retry's bytes overwrite rather than
    // accumulate.
    expect(bucket.signed).toHaveLength(2);
    expect(bucket.signed[1]).toEqual(bucket.signed[0]);
  });

  /**
   * A MISSING KEY IS LOUD, because the silent version is catastrophic: `undefined` hashes
   * perfectly well, so every mint on the deployment would derive the same ticket id and collapse
   * into ONE row — every sender's attachment overwriting the last. The type says required and the
   * route refuses without one; this is what happens to a caller that bypassed both, and two
   * fixtures in this repository did exactly that when the key was introduced.
   *
   * WATCHED RED by dropping the `if (!idempotencyKey)` throw: the mint succeeds under a ticket id
   * derived from the string "undefined".
   */
  it("refuses a mint with no key at all rather than hashing `undefined`", async () => {
    const { port } = armed({ maxTickets: 50, maxBytes: 1_000_000 });
    const accountId = await seedAccount();
    const err = await port.mint({
      accountId, filename: "a.bin", contentType: "application/octet-stream",
      sizeBytes: 1, now: NOW,
      idempotencyKey: undefined as unknown as string,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/idempotencyKey/);
    const rows = await db.select().from(attachmentStaging)
      .where(inArray(attachmentStaging.accountId, [accountId]));
    expect(rows).toHaveLength(0);
  });

  /** The vacuity guard — a port that answered one grant for everything would pass the case above. */
  it("different keys are different tickets and different object paths", async () => {
    const { port, bucket } = armed({ maxTickets: 50, maxBytes: 1_000_000 });
    const accountId = await seedAccount();
    const a = await mint(port, accountId, 1_024, "send-xyz:att:0");
    const b = await mint(port, accountId, 1_024, "send-xyz:att:1");
    expect(a.id).not.toBe(b.id);
    expect(bucket.signed[0]).not.toEqual(bucket.signed[1]);
  });
});
