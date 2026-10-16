import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq, inArray } from "drizzle-orm";
import { accounts, mailboxes, messages, folderState, flagState, changeLog } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { ScreenerService, type ServiceContext } from "@trafficflow/services";

/**
 * A SCREEN-OUT OR SPAM PRESS MARKS THE HELD MAIL READ, IN THE SAME TRANSACTION THAT
 * RE-ROUTES IT, AGAINST REAL POSTGRES.
 *
 * ## Why this is a `*.pg.test.ts`
 *
 * The whole claim is transactional: the `flag_state.desired_seen` write, the `messages.unread`
 * mirror and the `change_log` `update` delta all have to commit in the SAME transaction as the
 * `folder_state` re-route, so a client is never told mail moved without also being told it was
 * read — and vice versa. PGlite runs the statements but cannot observe the atomicity that matters
 * (a rival read between the folder write and the flag write), and CLAUDE.md requires the
 * transactional guarantees to be pinned on :5433.
 *
 * NO IMAP: the service is built with no adapter, exactly as the serverless API runs. This writes
 * DESIRED state — `desired_seen = true`, `pending` — and stops; the worker's `reconcileFlags`
 * adds `\Seen` on the real server (`apps/worker/src/sync.ts`). The write is ADDITIVE.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => new Date(),
  requestId: `f2-${randomUUID().slice(0, 8)}`,
});

interface World { accountId: string; held: string[]; address: string; }

/** One waiting first-contact sender with `each` UNREAD held messages (unread defaults true). */
async function newWorld(each = 3): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `f2-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `f2-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  const address = `post@ledgerandloom.test`;
  const held: string[] = [];
  for (let i = 0; i < each; i += 1) {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `f2:${randomUUID()}`,
      subject: `Bulletin ${i}`, fromAddress: address,
      nativeLocator: { folder: "ohmail/Screener", ref: `1:${i}` },
    }).returning();
    // No flag_state row — held mail has none at ingest, which is the INSERT branch the code seeds
    // `observed_seen` for. Left implicit so the test exercises exactly that path.
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    held.push(m!.id);
  }
  return { accountId, held, address };
}

const flagsOf = (ids: string[]) => db.select({
  id: flagState.messageId, desiredSeen: flagState.desiredSeen,
  observedSeen: flagState.observedSeen, status: flagState.reconcileStatus, lastSetBy: flagState.lastSetBy,
}).from(flagState).where(inArray(flagState.messageId, ids));

const unreadOf = (ids: string[]) => db.select({ id: messages.id, unread: messages.unread })
  .from(messages).where(inArray(messages.id, ids));

describe.skipIf(!PG_UP)("screen-out and spam mark the mail read in the reroute transaction", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  /**
   * THE ROW THIS SLICE EXISTS FOR. A `no` to either demoting folder marks every rerouted held
   * message read: `flag_state.desired_seen = true` (`pending`, so the worker will `\Seen` it),
   * `messages.unread = false`, and one `change_log` `update` delta per message beside the `move`.
   *
   * MUTATION-WATCHED: delete the `MARK_READ_ON_DECIDE.has(appliedFolder)` guard in
   * `@trafficflow/db#screener-apply.ts`'s `applyScreenerDecision` (0.14.1 moved the write
   * here from `screener-service.ts#decide` — see that function's own header) and both cases go
   * red — `flag_state` is empty and `unread` stays true.
   */
  for (const dest of ["ohmail/Screened", "ohmail/Quarantine"] as const) {
    it(`${dest} marks the rerouted mail read, additively and pending`, async () => {
      const w = await newWorld(3);
      await new ScreenerService({}).decide(ctx(w.accountId), w.held[0]!, { decision: "no", dest });

      const flags = await flagsOf(w.held);
      expect(flags).toHaveLength(3);
      expect(flags.every((f) => f.desiredSeen === true)).toBe(true);
      // Held mail was unread ⇒ observed_seen seeded false ⇒ pending ⇒ the worker will add \Seen.
      expect(flags.every((f) => f.observedSeen === false)).toBe(true);
      expect(flags.every((f) => f.status === "pending")).toBe(true);
      expect(flags.every((f) => f.lastSetBy === "us")).toBe(true);

      expect((await unreadOf(w.held)).every((r) => r.unread === false)).toBe(true);

      // One `update` delta per rerouted message — the read-state half — beside each `move`.
      const updates = await db.select().from(changeLog).where(and(
        eq(changeLog.accountId, w.accountId), eq(changeLog.entityType, "message"), eq(changeLog.op, "update"),
      )).orderBy(asc(changeLog.seq));
      expect(updates.map((r) => r.entityId).sort()).toEqual([...w.held].sort());
    });
  }

  /**
   * ADMITTED MAIL IS NOT READ. A `yes` (any keep folder) writes NO read-mark and leaves every
   * held message unread — the safety boundary `MARK_READ_ON_DECIDE` draws. Admitting a sender is
   * not the same as having read their backlog.
   *
   * MUTATION-WATCHED: widen the block's guard to `decision === "no"` alone and this still passes
   * (a yes is not a no); widen it to fire unconditionally and this goes red.
   */
  for (const dest of ["INBOX", "ohmail/News", "ohmail/Receipts"] as const) {
    it(`${dest} (a yes) touches no read state`, async () => {
      const w = await newWorld(3);
      await new ScreenerService({}).decide(ctx(w.accountId), w.held[0]!, { decision: "yes", dest });
      expect(await flagsOf(w.held)).toHaveLength(0);
      expect((await unreadOf(w.held)).every((r) => r.unread === true)).toBe(true);
      const updates = await db.select().from(changeLog).where(and(
        eq(changeLog.accountId, w.accountId), eq(changeLog.entityType, "message"), eq(changeLog.op, "update"),
      ));
      expect(updates).toHaveLength(0);
    });
  }
});
