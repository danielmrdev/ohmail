import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { stagingObjectPath, type AttachmentStagingStorage } from "@trafficflow/db/cloud";
import { makeAttachmentStagingPort, ServiceError } from "../src/index.js";

/**
 * THE FINALIZE STEP DELETES THE OBJECT IT CANNOT RECORD.
 *
 * Neither shipped store can revoke an upload grant it has already signed: a hosted-storage upload token
 * and an object-store presigned URL are both self-contained and honoured until they expire, and nothing of
 * ours is in the request path. So the last place a write that outlived its record can be answered
 * is the step that goes looking for it. A send naming a ticket that is not there refuses — it
 * always did — and now it also removes the bytes that ticket would have named, because the expiry
 * sweep works from tickets and will never look at them again.
 *
 * The path is derived and lies inside the caller's OWN account prefix, so the worst a made-up id
 * can reach is bytes of theirs that nothing names.
 */
const PG_UP = await realPgAvailable();
const NOW = new Date("2026-09-14T12:00:00.000Z");

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof brandDialect<ReturnType<typeof drizzle>>>;

function fakeStorage(): { storage: AttachmentStagingStorage; removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    storage: {
      async signUpload() { return { uploadUrl: "u", uploadMethod: "PUT", uploadHeaders: {} }; },
      async download() { return new Uint8Array(); },
      async remove(paths) { removed.push(...paths); },
    },
  };
}

async function seedAccount(): Promise<string> {
  const rows = await db.execute(sql`
    insert into accounts (name) values ('staged-finalize') returning id
  `);
  return (rows as unknown as Array<{ id: string }>)[0]!.id;
}

describe.skipIf(!PG_UP)("a send naming a ticket that is gone", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client), "pg");
  }, 180_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("refuses AND removes the bytes that ticket would have named", async () => {
    const accountId = await seedAccount();
    const fake = fakeStorage();
    const port = makeAttachmentStagingPort({
      db: db as unknown as Parameters<typeof makeAttachmentStagingPort>[0]["db"],
      storage: fake.storage,
    });
    const goneTicket = randomUUID();

    await expect(port.source.fetch(accountId, [goneTicket], NOW))
      .rejects.toBeInstanceOf(ServiceError);

    expect(fake.removed).toEqual([stagingObjectPath(accountId, goneTicket)]);
  }, 60_000);

  it("POSITIVE CONTROL: a live ticket's bytes are read, and nothing is removed", async () => {
    const accountId = await seedAccount();
    const fake = fakeStorage();
    const port = makeAttachmentStagingPort({
      db: db as unknown as Parameters<typeof makeAttachmentStagingPort>[0]["db"],
      storage: fake.storage,
    });

    const grant = await port.mint({
      accountId, filename: "f.bin", contentType: "application/octet-stream",
      sizeBytes: 4, now: NOW, idempotencyKey: randomUUID(),
    });
    const got = await port.source.fetch(accountId, [grant.id], NOW);

    expect(got).toHaveLength(1);
    expect(fake.removed, "a live ticket's object was removed").toEqual([]);
  }, 60_000);
});
