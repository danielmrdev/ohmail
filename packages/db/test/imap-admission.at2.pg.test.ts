import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authThrottle } from "../src/schema.js";
import {
  acquireImapSlot, releaseImapSlot, imapAdmissionKey, IMAP_ADMISSION_WINDOW_MS,
} from "../src/imap-admission.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * **THE CROSS-PROCESS HALF OF THE IMAP CONNECTION CAP, ON A REAL POSTGRES.**
 *
 * The API is serverless. A per-instance semaphore bounds one warm instance, and a browser firing
 * several attachment requests at once is not guaranteed to land in one — so the only thing that
 * bounds the ACCOUNT is a counter both instances can see. That counter's whole correctness is a
 * question about a row lock under genuine parallelism, and PGlite is a single connection: the
 * interleaving this file is about is unreachable there, exactly as it was for the concurrent
 * `Idempotency-Key` race. Every acquirer below therefore gets its OWN physical connection.
 *
 * What it proves:
 *   • N simultaneous acquirers on N connections admit at most `max` — the property the cap IS;
 *   • a refusal gives its over-count straight back, so a burst cannot lock a mailbox out;
 *   • a release returns exactly one slot and the counter floors at zero;
 *   • a slot leaked by a killed invocation is reclaimed by the stale window and not for ever,
 *     which is the difference between a cap and a permanently unreadable mailbox;
 *   • two mailboxes do not contend.
 *
 * To watch it bite, change `held <= input.max` to `held <= input.max + 1` in `imap-admission.ts`:
 * the first test admits three.
 */

const DB_URL = PG_TEST_URL;
const HAVE_PG = await realPgAvailable(DB_URL);

const MAX = 2;

describe.skipIf(!HAVE_PG)("per-mailbox IMAP admission counter (real Postgres)", () => {
  /** One connection per acquirer: a shared pool would serialise the very race under test. */
  let clients: ReturnType<typeof postgres>[] = [];
  let dbs: ReturnType<typeof drizzle>[] = [];
  const mailboxIds: string[] = [];

  beforeAll(async () => {
    for (let i = 0; i < 6; i += 1) {
      const c = postgres(DB_URL, { max: 1 });
      clients.push(c);
      dbs.push(brandDialect(drizzle(c), "pg"));
    }
  }, 60_000);

  afterAll(async () => {
    for (const id of mailboxIds) {
      await dbs[0]?.delete(authThrottle).where(eq(authThrottle.key, imapAdmissionKey(id))).catch(() => undefined);
    }
    await Promise.all(clients.map((c) => c.end({ timeout: 5 })));
    clients = [];
    dbs = [];
  });

  /** A mailbox id nobody else in the suite is using, registered for teardown. */
  function freshMailbox(): string {
    const id = randomUUID();
    mailboxIds.push(id);
    return id;
  }

  /** The counter's current value, straight from the row. */
  async function counter(mailboxId: string): Promise<number> {
    const rows = await dbs[0]!.select({ failures: authThrottle.failures }).from(authThrottle)
      .where(eq(authThrottle.key, imapAdmissionKey(mailboxId)));
    return rows[0]?.failures ?? 0;
  }

  it("six simultaneous acquirers on six connections admit at most the cap", async () => {
    const mailboxId = freshMailbox();
    const now = new Date();

    const results = await Promise.all(
      dbs.map((db) => acquireImapSlot(db, { mailboxId, max: MAX, now })),
    );

    const admitted = results.filter(Boolean).length;
    expect(admitted).toBe(MAX);
    // And the refusals gave their over-count back: the row says exactly what is held.
    expect(await counter(mailboxId)).toBe(MAX);
  });

  it("a release returns exactly one slot", async () => {
    const mailboxId = freshMailbox();
    const now = new Date();

    expect(await acquireImapSlot(dbs[0]!, { mailboxId, max: MAX, now })).toBe(true);
    expect(await acquireImapSlot(dbs[1]!, { mailboxId, max: MAX, now })).toBe(true);
    expect(await acquireImapSlot(dbs[2]!, { mailboxId, max: MAX, now })).toBe(false);

    await releaseImapSlot(dbs[0]!, mailboxId, now);
    expect(await counter(mailboxId)).toBe(1);

    // The slot freed by that release is available to a DIFFERENT connection — the whole point.
    expect(await acquireImapSlot(dbs[3]!, { mailboxId, max: MAX, now })).toBe(true);
    expect(await acquireImapSlot(dbs[4]!, { mailboxId, max: MAX, now })).toBe(false);
  });

  it("the counter floors at zero — a stray release cannot mint budget", async () => {
    const mailboxId = freshMailbox();
    const now = new Date();

    expect(await acquireImapSlot(dbs[0]!, { mailboxId, max: MAX, now })).toBe(true);
    for (let i = 0; i < 5; i += 1) await releaseImapSlot(dbs[0]!, mailboxId, now);

    expect(await counter(mailboxId)).toBe(0);
    // If it had gone negative, this mailbox would silently be allowed MAX + 5 connections.
    expect(await acquireImapSlot(dbs[0]!, { mailboxId, max: MAX, now })).toBe(true);
    expect(await acquireImapSlot(dbs[1]!, { mailboxId, max: MAX, now })).toBe(true);
    expect(await acquireImapSlot(dbs[2]!, { mailboxId, max: MAX, now })).toBe(false);
  });

  it("a slot LEAKED by a killed invocation is reclaimed when the window goes stale", async () => {
    const mailboxId = freshMailbox();
    const now = new Date();

    // Fill the cap and never release — a serverless invocation killed at `maxDuration` runs no
    // `finally`, so this is not a hypothetical.
    expect(await acquireImapSlot(dbs[0]!, { mailboxId, max: MAX, now })).toBe(true);
    expect(await acquireImapSlot(dbs[1]!, { mailboxId, max: MAX, now })).toBe(true);
    expect(await acquireImapSlot(dbs[2]!, { mailboxId, max: MAX, now })).toBe(false);

    // Time is passed as a parameter rather than slept, so this asserts the RULE and not the clock.
    const later = new Date(now.getTime() + IMAP_ADMISSION_WINDOW_MS + 1_000);
    expect(await acquireImapSlot(dbs[3]!, { mailboxId, max: MAX, now: later })).toBe(true);
    // Reclaimed, not merely incremented: the stale window RESETS the count to this one holder.
    expect(await counter(mailboxId)).toBe(1);
  });

  it("a live window is NOT reclaimed early — the reclaim must not race a live connection", async () => {
    const mailboxId = freshMailbox();
    const now = new Date();

    expect(await acquireImapSlot(dbs[0]!, { mailboxId, max: MAX, now })).toBe(true);
    expect(await acquireImapSlot(dbs[1]!, { mailboxId, max: MAX, now })).toBe(true);

    // One second short of the horizon, and comfortably beyond the 60 s `maxDuration` that bounds
    // how long any of those connections can live. Still counted.
    const nearly = new Date(now.getTime() + IMAP_ADMISSION_WINDOW_MS - 1_000);
    expect(await acquireImapSlot(dbs[2]!, { mailboxId, max: MAX, now: nearly })).toBe(false);
    expect(await counter(mailboxId)).toBe(MAX);
  });

  it("two mailboxes do not contend — one provider must not starve the other", async () => {
    const a = freshMailbox();
    const b = freshMailbox();
    const now = new Date();

    expect(await acquireImapSlot(dbs[0]!, { mailboxId: a, max: MAX, now })).toBe(true);
    expect(await acquireImapSlot(dbs[1]!, { mailboxId: a, max: MAX, now })).toBe(true);
    expect(await acquireImapSlot(dbs[2]!, { mailboxId: a, max: MAX, now })).toBe(false);

    // `b` is untouched by `a`'s saturation.
    expect(await acquireImapSlot(dbs[3]!, { mailboxId: b, max: MAX, now })).toBe(true);
    expect(await acquireImapSlot(dbs[4]!, { mailboxId: b, max: MAX, now })).toBe(true);
  });

  it("the row is a plain counter — it carries no mail content and no credential", async () => {
    const mailboxId = freshMailbox();
    await acquireImapSlot(dbs[0]!, { mailboxId, max: MAX, now: new Date() });

    const [row] = await dbs[0]!.select().from(authThrottle)
      .where(eq(authThrottle.key, imapAdmissionKey(mailboxId)));
    // The key is `imap:mailbox:<uuid>` and nothing else: no address, no host, no user, no secret.
    expect(row!.key).toBe(`imap:mailbox:${mailboxId}`);
    expect(row!.lockedUntil).toBeNull();
  });

  it("the namespace is distinct from every other user of this table", async () => {
    // `auth_throttle` is shared with `mail:`, `waitlist:ip:`, `register:ip:`, `verify:ip:` and the
    // login lockout. A namespace collision would let a signup burst refuse an attachment download.
    const rows = await dbs[0]!.execute(
      sql`select count(*)::int as n from auth_throttle where key like 'imap:mailbox:%'
          and (key like 'mail:%' or key like '%:ip:%' or key like 'user:%' or key like 'email:%')`,
    );
    expect(Number((rows as unknown as { n: number }[])[0]?.n ?? 0)).toBe(0);
  });
});
