import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { brandDialect } from "../src/dialect/index.js";

/**
 * ═══ mail 0106 — A CONSENTED MAILBOX MAY NOT HAVE A NULL SCREENING BASELINE ═══════════════
 *
 * The baseline is the instant a dormancy window is measured back from. NULL is not "unanswered":
 * the cutline falls back to `now() - dormancy_days`, which slides forward at the speed of the
 * clock, so on a mailbox with any history every unruled sender's whole past is held at the gate —
 * the hold of a great many messages, reproduced by arithmetic rather than by a bug. Several managed
 * accounts carried the NULL, each consented through a door that asked no window.
 *
 * The doors stamp at consent now. This migration is the half that cannot be fixed forward: it
 * gives each such account the instant it FIRST agreed. The cases below are the shapes that
 * production actually holds, and the two that must NOT move are as load-bearing as the four that
 * must: a live account whose baseline is in force keeps it, and an account that consented to
 * nothing gets no baseline invented for it.
 *
 * REAL POSTGRES, not PGlite: the statement is one `INSERT … SELECT … ON CONFLICT … DO UPDATE …
 * WHERE`, and the conflict arm's `WHERE` is exactly the part a different engine could accept and
 * apply differently. A green run against a database that never applied the journal says nothing.
 *
 * MUTATION WATCHED RED: drop the ` WHERE "account_settings"."screening_baseline_at" IS NULL` from
 * `0106_screening_baseline_backfill.sql` and the live-account case reds — the backfill drags a
 * working cutline back to the day that account first consented.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MAIL_DIR = join(HERE, "..", "..", "db-mail", "drizzle");
const TAG = "0106_screening_baseline_backfill";

interface Journal { entries: Array<{ idx: number; tag: string }> }

/** The journal as it stood immediately before one migration, selected by that migration's TAG. */
function stagedBefore(full: Journal, tag: string): Journal {
  const under = full.entries.find((e) => e.tag === tag);
  if (under === undefined) throw new Error(`journal has no entry tagged ${tag}`);
  return { ...full, entries: full.entries.filter((e) => e.idx < under.idx) };
}

const ADMIN_URL = PG_TEST_URL;
const PG_UP = await realPgAvailable(ADMIN_URL);

/** The instants the fixtures consent at — distinct, so "which one was taken" is readable. */
const FIRST = new Date("2026-01-05T08:00:00.000Z");
const LATER = new Date("2026-04-05T08:00:00.000Z");
const IN_FORCE = new Date("2025-11-01T08:00:00.000Z");

describe.skipIf(!PG_UP)("mail 0106 — the NULL baselines of consented mailboxes", () => {
  const dbName = `tf_baseline_backfill_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase;
  let staged: string;

  /** The four shapes, plus the two that must not move and the one that must not be invented. */
  const NO_SETTINGS_ROW = randomUUID();
  const NULL_BASELINE_ROW = randomUUID();
  const TWO_MAILBOXES = randomUUID();
  const REMOVED_MAILBOX = randomUUID();
  const LIVE_BASELINE = randomUUID();
  const NEVER_CONSENTED = randomUUID();

  const account = async (id: string, name: string) =>
    db.execute(sql`INSERT INTO accounts (id, name) VALUES (${id}, ${name})`);

  const mailbox = async (acct: string, address: string, consentedAt: Date | null, status = "connected") =>
    db.execute(sql`
      INSERT INTO mailboxes (id, account_id, provider, address, status, organize_consented_at)
      VALUES (${randomUUID()}, ${acct}, 'imap', ${address}, ${status},
              ${consentedAt === null ? null : consentedAt.toISOString()}::timestamptz)`);

  /**
   * The stored baseline as an INSTANT, or `null` (a row with none) or `undefined` (no row).
   *
   * Read as an epoch rather than as the column: `db.execute` hands back whatever text the driver
   * renders a `timestamptz` as, in the SERVER’s zone — `2026-01-05 09:00:00+01` for an instant
   * this file wrote as `08:00Z`. Comparing that to a `Date` fails while the value is right, which
   * is a test that reads a timezone as a defect. The epoch has one spelling.
   */
  const baselineOf = async (acct: string): Promise<number | null | undefined> => {
    const rows = await db.execute<{ epoch: string | null }>(sql`
      SELECT extract(epoch from screening_baseline_at)::text AS epoch
        FROM account_settings WHERE account_id = ${acct}`);
    const list = rows as unknown as Array<{ epoch: string | null }>;
    if (list.length === 0) return undefined;
    const raw = list[0]!.epoch;
    return raw === null ? null : Math.round(Number(raw) * 1000);
  };

  beforeAll(async () => {
    admin = postgres(ADMIN_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    client = postgres(url.toString(), { max: 1, onnotice: () => {} });
    db = brandDialect(drizzle(client), "pg");

    // THE JOURNAL AS IT STOOD BEFORE THIS STEP — so the rows below are written by a schema that
    // has no backfill in it, which is the only way the backfill can be observed doing anything.
    staged = mkdtempSync(join(tmpdir(), "ohmail-baseline-staged-"));
    cpSync(MAIL_DIR, staged, { recursive: true });
    const full = JSON.parse(readFileSync(join(MAIL_DIR, "meta", "_journal.json"), "utf8")) as Journal;
    writeFileSync(
      join(staged, "meta", "_journal.json"),
      JSON.stringify(stagedBefore(full, TAG), null, 2),
    );
    await migrate(db, { migrationsFolder: staged, migrationsSchema: "drizzle_mail" });

    await account(NO_SETTINGS_ROW, "never opened settings");
    await mailbox(NO_SETTINGS_ROW, "a@ohmail.test", FIRST);

    await account(NULL_BASELINE_ROW, "has a row, no baseline");
    await mailbox(NULL_BASELINE_ROW, "b@ohmail.test", FIRST);
    await db.execute(sql`
      INSERT INTO account_settings (account_id, dormancy_days) VALUES (${NULL_BASELINE_ROW}, 30)`);

    await account(TWO_MAILBOXES, "two mailboxes, two consents");
    await mailbox(TWO_MAILBOXES, "c1@ohmail.test", LATER);
    await mailbox(TWO_MAILBOXES, "c2@ohmail.test", FIRST);

    await account(REMOVED_MAILBOX, "consented, then removed the mailbox");
    await mailbox(REMOVED_MAILBOX, "d@ohmail.test", FIRST, "disabled");

    await account(LIVE_BASELINE, "screening already running");
    await mailbox(LIVE_BASELINE, "e@ohmail.test", FIRST);
    await db.execute(sql`
      INSERT INTO account_settings (account_id, screening_baseline_at)
      VALUES (${LIVE_BASELINE}, ${IN_FORCE.toISOString()}::timestamptz)`);

    await account(NEVER_CONSENTED, "reads, organizes nothing");
    await mailbox(NEVER_CONSENTED, "f@ohmail.test", null);

    // AND NOW THE STEP UNDER TEST, alone.
    await migrate(db, { migrationsFolder: MAIL_DIR, migrationsSchema: "drizzle_mail" });
  }, 180_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 }).catch(() => {});
    await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => {});
    await admin?.end({ timeout: 5 }).catch(() => {});
    if (staged) rmSync(staged, { recursive: true, force: true });
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("the step actually ran — the journal carries it", async () => {
    const rows = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM drizzle_mail."__drizzle_migrations"`);
    const applied = Number((rows as unknown as Array<{ n: string }>)[0]!.n);
    const full = JSON.parse(readFileSync(join(MAIL_DIR, "meta", "_journal.json"), "utf8")) as Journal;
    expect(applied).toBe(full.entries.length);
  });

  it("AN ACCOUNT WITH NO SETTINGS ROW AT ALL gets one, stamped at its consent", async () => {
    // The shape the four managed accounts were in: an absent row reads exactly like a NULL
    // baseline, so an UPDATE-only backfill would have left them where they were.
    expect(await baselineOf(NO_SETTINGS_ROW)).toEqual(FIRST.getTime());
  });

  it("a settings row whose baseline is NULL is filled in", async () => {
    expect(await baselineOf(NULL_BASELINE_ROW)).toEqual(FIRST.getTime());
  });

  it("TWO CONSENTS ⇒ THE EARLIER ONE — when the account's screening history began", async () => {
    // Not the latest: a later baseline holds MORE mail, and the correction may only release.
    expect(await baselineOf(TWO_MAILBOXES)).toEqual(FIRST.getTime());
  });

  it("a mailbox since removed still evidences the consent that happened", async () => {
    expect(await baselineOf(REMOVED_MAILBOX)).toEqual(FIRST.getTime());
  });

  it("A BASELINE IN FORCE IS NEVER MOVED — the assertion the `WHERE` exists for", async () => {
    expect(await baselineOf(LIVE_BASELINE)).toEqual(IN_FORCE.getTime());
  });

  it("an account that consented to nothing gets no baseline invented for it", async () => {
    expect(await baselineOf(NEVER_CONSENTED)).toBeUndefined();
  });

  it("is IDEMPOTENT — a second run of the same statement moves nothing", async () => {
    const sqlText = readFileSync(join(MAIL_DIR, `${TAG}.sql`), "utf8");
    const statement = sqlText.split("--> statement-breakpoint")[0]!;
    await client.unsafe(statement);
    expect(await baselineOf(NO_SETTINGS_ROW)).toEqual(FIRST.getTime());
    expect(await baselineOf(LIVE_BASELINE)).toEqual(IN_FORCE.getTime());
    expect(await baselineOf(NEVER_CONSENTED)).toBeUndefined();
  });
});
