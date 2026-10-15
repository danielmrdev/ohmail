import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runMigrations } from "@trafficflow/db/admin";
import { accounts, mailboxes, messages, awayReplies, awaySenderState } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { and, eq } from "drizzle-orm";
import { makeDrizzleRepo } from "../../src/adapters/drizzle-repo.js";
import { mintMessageId } from "../../src/send.js";
import { parseMessageIds } from "../../src/threading.js";

/**
 * ═══ `markAwayReplyUndeliverable` AGAINST REAL POSTGRES ════════════════════════════════════
 *
 * ── WHY NOT PGlite ─────────────────────────────────────────────────────────────────────────
 *
 * The idempotence IS the `IS NULL` in the UPDATE's WHERE, and what it returns is a real row
 * count. A green PGlite run says nothing about either — this repository has been bitten twice by
 * an array bound into an `IN (…)` that PGlite accepted and Postgres refused, and the same
 * statement shape is here.
 *
 * ── WHAT THE COLUMN PROMISES ───────────────────────────────────────────────────────────────
 *
 * `undeliverable_at` answers "when did we learn this address is dead". A second report — the
 * same one re-observed, or another for the same correspondent — must not move it, or the answer
 * becomes a lie that walks forward for the length of the trip. The guard is in the statement and
 * not in a prior read: two ingest workers can reach it with the same report in hand.
 */

const AVAILABLE = await realPgAvailable();

describe.skipIf(!AVAILABLE)("markAwayReplyUndeliverable against real Postgres", () => {
  let owned: OwnedDb;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 180_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  /** A fresh account per case, so the shared cluster cannot make one of these answer another's. */
  async function world(address: string): Promise<{ accountId: string; mailboxId: string }> {
    const accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `dsn-${accountId.slice(0, 8)}` });
    const [mb] = await owned.db.insert(mailboxes)
      .values({ accountId, provider: "imap", address }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  /* A REAL message row for the ledger to name. Mail 0118 keys `away_replies` to
     `(message_id, account_id)`, so a minted uuid for a message that never existed is not a state
     the database has — and a double that cannot exist in production measures nothing. One message
     per ledger row, which is also what `away_replies_message_uq` expects. */
  async function message(w: { accountId: string; mailboxId: string }): Promise<string> {
    const [row] = await owned.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId,
      bodyHash: randomUUID(), dedupKey: `mid:${randomUUID()}`,
    }).returning();
    return row!.id;
  }

  /** One away reply on the ledger, and the sender-state row a real reply would have written. */
  async function replied(
    w: { accountId: string; mailboxId: string }, sender: string, minted: string,
    opts: { withState?: boolean } = {},
  ): Promise<void> {
    await owned.db.insert(awayReplies).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: await message(w),
      sender, outcome: "sent", mintedMessageId: minted,
    });
    if (opts.withState !== false) {
      await owned.db.insert(awaySenderState).values({
        accountId: w.accountId, sender, lastRepliedAt: new Date(), lastTextHash: "h",
      });
    }
  }

  const stampOf = async (accountId: string, sender: string): Promise<Date | null> => {
    const [row] = await owned.db.select().from(awaySenderState)
      .where(and(eq(awaySenderState.accountId, accountId), eq(awaySenderState.sender, sender)));
    return row?.undeliverableAt ?? null;
  };

  const repoFor = () => makeDrizzleRepo(owned.db as never);

  it("stamps exactly the correspondent the quoted id names, and answers 1", async () => {
    const w = await world(`${randomUUID()}@dsn.test`);
    const dead = `dead-${randomUUID()}@elsewhere.example`;
    const alive = `alive-${randomUUID()}@elsewhere.example`;
    const minted = mintMessageId("dsn.test");
    await replied(w, dead, minted);
    await replied(w, alive, mintMessageId("dsn.test"));

    const at = new Date("2026-03-01T10:00:00.000Z");
    expect(await repoFor().markAwayReplyUndeliverable(
      w.accountId, parseMessageIds([`In-Reply-To: ${minted}`]), at,
    )).toBe(1);

    expect((await stampOf(w.accountId, dead))!.getTime()).toBe(at.getTime());
    expect(await stampOf(w.accountId, alive)).toBeNull();
  });

  it("a SECOND report answers 0 and does not move the instant", async () => {
    const w = await world(`${randomUUID()}@dsn.test`);
    const dead = `dead-${randomUUID()}@elsewhere.example`;
    const minted = mintMessageId("dsn.test");
    await replied(w, dead, minted);
    const ids = parseMessageIds([`In-Reply-To: ${minted}`]);

    const first = new Date("2026-03-01T10:00:00.000Z");
    expect(await repoFor().markAwayReplyUndeliverable(w.accountId, ids, first)).toBe(1);

    /* THE GUARD. A later instant, so a moved stamp is visible rather than a coincidence — the
       count and the column are asserted separately, because an UPDATE that wrote the row and
       returned it would answer 1 with the same value. */
    const later = new Date("2026-03-08T10:00:00.000Z");
    expect(await repoFor().markAwayReplyUndeliverable(w.accountId, ids, later)).toBe(0);
    expect((await stampOf(w.accountId, dead))!.getTime()).toBe(first.getTime());
  });

  it("a MIXED-CASE legacy minted id is found, quoted back in its own case", async () => {
    const w = await world(`${randomUUID()}@DSN.Test`);
    const dead = `dead-${randomUUID()}@elsewhere.example`;
    // What the unfolded mint used to write, and how a report quotes it back verbatim.
    const minted = `<${randomUUID()}@DSN.Test>`;
    await replied(w, dead, minted);

    const ids = parseMessageIds([`In-Reply-To: ${minted}`]);
    expect(ids[0], "parseMessageIds folded the case").toContain("@DSN.Test");

    const at = new Date("2026-03-01T10:00:00.000Z");
    expect(await repoFor().markAwayReplyUndeliverable(w.accountId, ids, at)).toBe(1);
    expect((await stampOf(w.accountId, dead))!.getTime()).toBe(at.getTime());
  });

  it("is ACCOUNT-SCOPED — another account's minted id stamps nobody here", async () => {
    const mine = await world(`${randomUUID()}@dsn.test`);
    const theirs = await world(`${randomUUID()}@dsn.test`);
    const dead = `dead-${randomUUID()}@elsewhere.example`;
    const minted = mintMessageId("dsn.test");
    await replied(theirs, dead, minted);
    await replied(mine, dead, mintMessageId("dsn.test"));

    expect(await repoFor().markAwayReplyUndeliverable(
      mine.accountId, parseMessageIds([`In-Reply-To: ${minted}`]), new Date(),
    )).toBe(0);
    expect(await stampOf(mine.accountId, dead)).toBeNull();
    expect(await stampOf(theirs.accountId, dead)).toBeNull();
  });

  it("a correspondent with no sender-state row is not invented", async () => {
    const w = await world(`${randomUUID()}@dsn.test`);
    const dead = `dead-${randomUUID()}@elsewhere.example`;
    const minted = mintMessageId("dsn.test");
    await replied(w, dead, minted, { withState: false });

    expect(await repoFor().markAwayReplyUndeliverable(
      w.accountId, parseMessageIds([`In-Reply-To: ${minted}`]), new Date(),
    )).toBe(0);
    expect(await stampOf(w.accountId, dead)).toBeNull();
  });

  it("an EMPTY candidate list writes nothing", async () => {
    const w = await world(`${randomUUID()}@dsn.test`);
    const dead = `dead-${randomUUID()}@elsewhere.example`;
    await replied(w, dead, mintMessageId("dsn.test"));

    expect(await repoFor().markAwayReplyUndeliverable(w.accountId, [], new Date())).toBe(0);
    expect(await stampOf(w.accountId, dead)).toBeNull();
  });
});
