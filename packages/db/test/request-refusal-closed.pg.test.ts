import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { REQUEST_REFUSAL_REASONS } from "@trafficflow/core/adapters/organizer-lease";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  `organizer_requests.refused_reason` IS A CLOSED SET, AND THE DATABASE IS WHAT CLOSES IT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * mail 0091. The write path was already closed in code — an organizer's acknowledgement is verified
 * under the account's key before it is read, and `parseAck` maps any reason outside the vocabulary
 * to NULL — and that argument is the one the operator console's isolation sweep cannot check. It
 * sees constraints, not parsers, so a set that lives only in application code is classified as free
 * text, correctly; and the argument stops being true the moment a second write path exists, with
 * nothing failing when it does.
 *
 * This is the assertion PGlite cannot stand in for. The constraint's whole content is what REAL
 * Postgres does with a value outside the set, and a green run against a database that never ran the
 * migration would say nothing at all — so the migrations are applied here and the refusal is read
 * off the server.
 *
 * ── AND THE SET IS READ FROM THE CODE, NOT RETYPED ───────────────────────────────────────────
 *
 * `REQUEST_REFUSAL_REASONS` is the vocabulary the parser enforces. Retyping it here would let the
 * two drift in the direction that fails silently: a ninth reason added to the code and not to the
 * constraint is a refusal the database rejects at the moment the drain tries to record it, on a
 * path whose whole job is to tell somebody their decision was refused.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MAIL_DIR = join(HERE, "..", "..", "db-mail", "drizzle");
const ADMIN_URL = PG_TEST_URL;
const PG_UP = await realPgAvailable(ADMIN_URL);

const ACCT = randomUUID();

describe.skipIf(!PG_UP)("mail 0091 — the refusal vocabulary, enforced by Postgres", () => {
  const dbName = `tf_refusal_closed_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase;
  let mailboxId: string;

  beforeAll(async () => {
    admin = postgres(ADMIN_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    client = postgres(url.toString(), { max: 1, onnotice: () => {} });
    db = brandDialect(drizzle(client), "pg");
    await migrate(db, { migrationsFolder: MAIL_DIR, migrationsSchema: "drizzle_mail" });

    await db.execute(sql`INSERT INTO accounts (id, name) VALUES (${ACCT}, 'refusal')`);
    const rows = await db.execute<{ id: string }>(sql`
      INSERT INTO mailboxes (account_id, provider, address)
      VALUES (${ACCT}, 'imap', ${`${randomUUID()}@x.example`})
      RETURNING id`);
    mailboxId = (rows as unknown as Array<{ id: string }>)[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 }).catch(() => {});
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => {});
    await admin?.end({ timeout: 5 }).catch(() => {});
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  /** One `refused` row carrying `reason`, or the database's refusal. */
  async function insertRefused(reason: string | null): Promise<void> {
    await db.execute(sql`
      INSERT INTO organizer_requests (id, account_id, mailbox_id, kind, payload, decided_at, state, refused_reason)
      VALUES (${randomUUID()}, ${ACCT}, ${mailboxId}, 'screener.decide', ${'{}'}::jsonb,
              now(), 'refused', ${reason})`);
  }

  it("the constraint exists under the name the health probe asks for", async () => {
    const rows = await db.execute<{ conname: string }>(sql`
      SELECT conname FROM pg_constraint WHERE conname = 'organizer_requests_refused_reason_closed'`);
    expect((rows as unknown as unknown[]).length).toBe(1);
  });

  it("every member of the vocabulary is accepted — the set is not narrower than the code's", async () => {
    // A throw fails the case, and the message names the member: a constraint narrower than the
    // parser's vocabulary is a refusal the database rejects at the moment the drain tries to record
    // one, on the path whose whole job is to say a decision was refused.
    for (const reason of REQUEST_REFUSAL_REASONS) {
      await insertRefused(reason).catch((err: unknown) => {
        throw new Error(`the database refused '${reason}', which the parser writes: ${String(err)}`);
      });
    }
    const rows = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM organizer_requests WHERE refused_reason IS NOT NULL`);
    expect(Number((rows as unknown as Array<{ n: string }>)[0]!.n))
      .toBe(REQUEST_REFUSAL_REASONS.length);
  });

  /** NULL already means "a refusal whose named cause this build does not recognise". */
  it("NULL is accepted — an unrecognised cause is stored as nothing, never as free text", async () => {
    await insertRefused(null);
    const rows = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM organizer_requests WHERE refused_reason IS NULL`);
    expect(Number((rows as unknown as Array<{ n: string }>)[0]!.n)).toBeGreaterThan(0);
  });

  /**
   * THE ASSERTION THIS FILE EXISTS FOR.
   *
   * MUTATION WATCHED RED: drop the `ADD CONSTRAINT` from `0091_request_refusal_closed.sql` and this
   * insert succeeds — the column is free text again, the isolation census's classification of it
   * becomes an assertion about free text, and nothing else in the product misbehaves.
   */
  it("a value OUTSIDE the vocabulary is refused by the database", async () => {
    await expect(insertRefused("Re: your invoice — see attached")).rejects.toThrow(
      /organizer_requests_refused_reason_closed|violates check constraint/i,
    );
  });

  it("the empty string is refused too — it is not a member, and it is not NULL", async () => {
    await expect(insertRefused("")).rejects.toThrow(/violates check constraint/i);
  });
});
