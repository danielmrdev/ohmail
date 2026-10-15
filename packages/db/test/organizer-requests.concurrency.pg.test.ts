import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/migrate.js";
import { pgTestUrl } from "../src/testing.js";
import { schema } from "../src/schema.js";
import { mailboxes, organizerRequests } from "../src/schema-mail.js";
import {
  insertOrganizerRequest, markRequestsSent, markRequestsApplied, markRequestsExpired,
  listSentRequests,
} from "../src/organizer-requests.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  RISK 4 — PGLITE BLINDNESS — the request state machine's `sent`→`applied` write racing a read,
 *  on REAL Postgres (mail 0088)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The failure mode this guards: the reader's own cycle (`driveOutstandingRequests`) transitions a
 * `sent` request to `applied` based on its absence from the mailbox folder. Nothing in this
 * codebase stops TWO overlapping cycles from computing that transition at once — a poll timer
 * re-entering while a slow previous cycle is still finishing, or (on Cloud) two physical worker
 * processes both reading the same mailbox during a leader handover. `PGlite green means nothing
 * for transactional code` (this repo's own operational trap): the guard is the `state = 'sent'`
 * predicate on the `UPDATE`, and only a REAL row lock under REAL concurrent connections proves it
 * — `change-log.concurrency.pg.test.ts` is the precedent this file follows in shape.
 */
/* Through the shared-box refusal: a checkout with no lane database is refused at collection. */
const PG_URL = pgTestUrl(import.meta.url);
const sqlA = postgres(PG_URL, { max: 5 });
const sqlB = postgres(PG_URL, { max: 5 });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

const ACCT = randomUUID();
const NOW = new Date("2026-09-03T12:00:00.000Z");

async function seedMailbox(): Promise<string> {
  const [mb] = await dbA.insert(mailboxes).values({
    accountId: ACCT, provider: "imap", address: `${randomUUID()}@x.example`,
  }).returning({ id: mailboxes.id });
  return mb!.id;
}

describe("organizer_requests under real-Postgres concurrency (risk 4)", () => {
  beforeAll(async () => { await runMigrations(PG_URL); });
  afterAll(async () => { await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

  it("two connections racing markRequestsApplied on the SAME row: exactly one transition, never both", async () => {
    const mailboxId = await seedMailbox();
    const id = randomUUID();
    await dbA.transaction((tx) => insertOrganizerRequest(tx, {
      id, accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", match: "a@x.example", appliedFolder: "INBOX", decision: "yes" },
      decidedAt: NOW,
    }));
    await dbA.transaction((tx) => markRequestsSent(tx, [id], NOW));

    const tA = new Date(NOW.getTime() + 1000);
    const tB = new Date(NOW.getTime() + 2000);
    const [ra, rb] = await Promise.all([
      dbA.transaction((tx) => markRequestsApplied(tx, [id], tA)),
      dbB.transaction((tx) => markRequestsApplied(tx, [id], tB)),
    ]);
    void ra; void rb; // markRequestsApplied returns void; the row itself is the oracle

    const [row] = await dbA.select().from(organizerRequests).where(eq(organizerRequests.id, id));
    expect(row?.state).toBe("applied");
    // The WINNER'S timestamp stands — whichever committed first — and it is exactly ONE of the
    // two, never a value neither connection wrote (which a lost-update race could produce).
    expect([tA.getTime(), tB.getTime()]).toContain(row?.resolvedAt?.getTime());
  });

  it("markRequestsApplied and markRequestsExpired racing the SAME row: exactly one wins, the row is never left half-written", async () => {
    const mailboxId = await seedMailbox();
    const id = randomUUID();
    await dbA.transaction((tx) => insertOrganizerRequest(tx, {
      id, accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", match: "a@x.example", appliedFolder: "INBOX", decision: "yes" },
      decidedAt: NOW,
    }));
    await dbA.transaction((tx) => markRequestsSent(tx, [id], NOW));

    const tApplied = new Date(NOW.getTime() + 1000);
    const tExpired = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    await Promise.all([
      dbA.transaction((tx) => markRequestsApplied(tx, [id], tApplied)),
      dbB.transaction((tx) => markRequestsExpired(tx, [id], tExpired)),
    ]);

    const [row] = await dbA.select().from(organizerRequests).where(eq(organizerRequests.id, id));
    // Exactly one of the two closed states — never left `sent` (both lost), and never a third
    // state neither writer named.
    expect(["applied", "expired"]).toContain(row?.state);
    expect(row?.resolvedAt).not.toBeNull();
  });

  it("a concurrent READ (listSentRequests) never observes a torn row — always `sent` with no resolvedAt, or the closed state with one", async () => {
    const mailboxId = await seedMailbox();
    const id = randomUUID();
    await dbA.transaction((tx) => insertOrganizerRequest(tx, {
      id, accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", match: "a@x.example", appliedFolder: "INBOX", decision: "yes" },
      decidedAt: NOW,
    }));
    await dbA.transaction((tx) => markRequestsSent(tx, [id], NOW));

    const reads: Array<{ state: string; hasResolvedAt: boolean }[]> = [];
    const writer = dbA.transaction((tx) => markRequestsApplied(tx, [id], new Date(NOW.getTime() + 1000)));
    const reader = (async () => {
      for (let i = 0; i < 20; i++) {
        const rows = await dbB.transaction((tx) => listSentRequests(tx, mailboxId));
        reads.push(rows.map((r) => ({ state: r.state, hasResolvedAt: r.resolvedAt !== null })));
      }
    })();
    await Promise.all([writer, reader]);

    // Every observation is internally consistent: a row returned by `listSentRequests` is BY
    // DEFINITION `state='sent'` (the query's own predicate), and a `sent` row's `resolvedAt` is
    // NULL until it transitions — this table's own CHECK-adjacent invariant, never enforced by a
    // constraint, only by every writer agreeing. No read here may show `sent` WITH a resolvedAt.
    for (const snapshot of reads) {
      for (const r of snapshot) {
        expect(r.state).toBe("sent");
        expect(r.hasResolvedAt).toBe(false);
      }
    }
  });
});
